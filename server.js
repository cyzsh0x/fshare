const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const admin = require('firebase-admin');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Bottleneck = require('bottleneck');

// Initialize Firebase
const serviceAccount = require('./fshareKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://fshare-booster-default-rtdb.firebaseio.com/"
});
const db = admin.database();
const sessionsRef = db.ref('sessions');
const counterRef = db.ref('sessionCounter');
const queueRef = db.ref('queue');

const PORT = process.env.PORT || 11001;
const app = express();
const BACKUP_INTERVAL = 1000 * 60 * 1; // 1 minute
const REQUIRED_HEADER = process.env.RH; // Custom header for API protection
const HEADER_VALUE = process.env.HV; // Expected value for the header
const MAX_CONSECUTIVE_FAILURES = 10; // Maximum allowed consecutive failures
const MAX_PARALLEL_SESSIONS = 5; // Maximum parallel sessions per worker
const WORKER_COUNT = process.env.WORKER_COUNT || 4; // Number of worker threads

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with ${WORKER_COUNT} workers`);
});

const wss = new WebSocket.Server({ server });
const clients = new Set();

// Rate limiter for API calls
const apiLimiter = new Bottleneck({
  maxConcurrent: 50,
  minTime: 100 // 10 requests per second max
});

// Rate limiter for Facebook operations
const fbOperationLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 200 // 5 operations per second max
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('New WebSocket client connected');
  broadcastActiveSessions();
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('WebSocket client disconnected');
  });
});

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Worker thread function
if (!isMainThread) {
  const { sessionId } = workerData;
  processSession(sessionId);
}

function checkHeader(req, res, next) {
  if (req.headers[REQUIRED_HEADER.toLowerCase()] !== HEADER_VALUE) {
    return res.status(403).json({ 
      error: 'Forbidden',
      message: 'You can\'t use the API. This is to avoid the abuse of the API.'
    });
  }
  next();
}

function convertJsonToCookieString(cookieJson) {
  if (!Array.isArray(cookieJson)) {
    throw new Error('Cookie JSON must be an array');
  }
  
  return cookieJson
    .filter(item => item.key && item.value)
    .map(item => `${item.key}=${item.value}`)
    .join('; ');
}

// Helper functions
function generateSessionId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function getNextSessionNumber() {
  const snapshot = await counterRef.once('value');
  const currentValue = snapshot.val();
  
  // If no active sessions exist, reset counter to 0 first
  const sessions = await readSessions();
  const activeSessions = Object.values(sessions).filter(s => ['started', 'in_progress'].includes(s.status));
  if (activeSessions.length === 0 && currentValue !== 0) {
    await counterRef.set(0);
    return 1;
  }
  
  // Otherwise increment normally
  const newValue = (currentValue || 0) + 1;
  await counterRef.set(newValue);
  return newValue;
}

async function readSessions() {
  try {
    const snapshot = await sessionsRef.once('value');
    return snapshot.val() || {};
  } catch (error) {
    console.error('Error reading sessions:', error);
    return {};
  }
}

async function writeSessions(sessions) {
  try {
    await sessionsRef.set(sessions);
  } catch (error) {
    console.error('Error writing sessions:', error);
  }
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [
    h > 0 ? `${h}h` : '',
    m > 0 ? `${m}m` : '',
    `${s}s`
  ].filter(Boolean).join(' ');
}

async function broadcastActiveSessions() {
  const sessions = await readSessions();
  const now = Date.now();
  
  const activeSessions = Object.entries(sessions)
    .filter(([_, session]) => ['started', 'in_progress'].includes(session.status))
    .sort((a, b) => a[1].sessionNumber - b[1].sessionNumber)
    .map(([id, session]) => {
      const elapsedSeconds = (now - new Date(session.createdAt).getTime()) / 1000;
      const sharesPerSecond = session.completedShares / elapsedSeconds;
      const remainingShares = session.totalShares - (session.completedShares || 0);
      const estimatedTime = sharesPerSecond > 0 ? remainingShares / sharesPerSecond : Infinity;

      return {
        id,
        sessionNumber: session.sessionNumber,
        url: session.url,
        amount: session.totalShares,
        interval: session.interval,
        completed: session.completedShares || 0,
        failed: session.failedShares || 0,
        successRate: session.completedShares > 0 ? 
          ((session.completedShares / (session.completedShares + (session.failedShares || 0))) * 100).toFixed(2) : '0.00',
        startedAt: session.createdAt,
        estimatedTime: estimatedTime < Infinity ? 
          formatTime(estimatedTime) : 'Calculating...'
      };
    });

  const totalShares = Object.values(sessions).reduce((sum, s) => sum + (s.completedShares || 0), 0);
  const totalFailed = Object.values(sessions).reduce((sum, s) => sum + (s.failedShares || 0), 0);
  const successRate = totalShares > 0 ? 
    ((totalShares / (totalShares + totalFailed)) * 100).toFixed(2) : '0.00';

  const message = {
    type: 'sessions_update',
    data: {
      activeSessions,
      stats: {
        totalShares,
        successRate
      }
    }
  };

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

async function saveProgress(sessionId, progress) {
  const sessions = await readSessions();
  
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      createdAt: new Date().toISOString(),
      status: 'started',
      totalShares: 0,
      completedShares: 0,
      failedShares: 0,
      lastUpdated: new Date().toISOString()
    };
  }
  
  sessions[sessionId] = {
    ...sessions[sessionId],
    ...progress,
    lastUpdated: new Date().toISOString(),
    successRate: progress.completedShares > 0 ? 
      ((progress.completedShares / 
        (progress.completedShares + (progress.failedShares || 0))) * 100).toFixed(2) : '0.00'
  };
  
  await writeSessions(sessions);
  await broadcastActiveSessions();
}

// Facebook API functions
async function validateCookie(cookie) {
  try {
    let cookieString;
    
    if (typeof cookie === 'string') {
      try {
        const cookieJson = JSON.parse(cookie);
        cookieString = convertJsonToCookieString(cookieJson);
      } catch (e) {
        cookieString = cookie;
      }
    } else if (Array.isArray(cookie)) {
      cookieString = convertJsonToCookieString(cookie);
    } else {
      return false;
    }

    const headers = {
      "authority": "business.facebook.com",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "cookie": cookieString,
      "referer": "https://www.facebook.com/",
      "sec-ch-ua": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    return response.status === 200;
  } catch (error) {
    console.error("Cookie validation failed:", error.message);
    return false;
  }
}

async function getFacebookToken(cookie) {
  try {
    let cookieString;
    
    if (typeof cookie === 'string') {
      try {
        const cookieJson = JSON.parse(cookie);
        cookieString = convertJsonToCookieString(cookieJson);
      } catch (e) {
        cookieString = cookie;
      }
    } else if (Array.isArray(cookie)) {
      cookieString = convertJsonToCookieString(cookie);
    } else {
      return null;
    }

    const headers = {
      "authority": "business.facebook.com",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "cookie": cookieString,
      "referer": "https://www.facebook.com/",
      "sec-ch-ua": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    const token = response.data.split("EAAG")[1].split('","')[0];
    return `${cookieString}|EAAG${token}`;
  } catch (error) {
    console.error("Failed to retrieve token:", error.message);
    return null;
  }
}

async function getPostId(postLink) {
  try {
    const response = await axios.post(
      "https://id.traodoisub.com/api.php",
      new URLSearchParams({ link: postLink }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
        }
      }
    );
    return response.data.id || null;
  } catch (error) {
    console.error("Error getting post ID:", error.message);
    return null;
  }
}

async function performShare(cookie, token, postId) {
  try {
    const shareUrl = `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${postId}&published=0&access_token=${token}`;
    
    const headers = {
      "authority": "graph.facebook.com",
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cookie": cookie,
      "referer": "https://www.facebook.com/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
    };

    const response = await axios.post(shareUrl, null, { headers });
    return response.data && response.data.id;
  } catch (error) {
    console.error("Share failed:", error.message);
    return false;
  }
}

async function processSession(sessionId) {
  try {
    const sessions = await readSessions();
    const session = sessions[sessionId];
    
    if (!session) {
      console.error(`Session ${sessionId} not found`);
      return;
    }

    const { cookie, url, amount, interval } = session;
    
    const isAlive = await validateCookie(cookie);
    if (!isAlive) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Invalid cookie',
        failedShares: amount
      });
      return;
    }

    const facebookToken = await getFacebookToken(cookie);
    if (!facebookToken) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Token retrieval failed',
        failedShares: amount
      });
      return;
    }
    const [retrievedCookie, token] = facebookToken.split("|");

    const postId = await getPostId(url);
    if (!postId) {
      await saveProgress(sessionId, { 
        status: 'failed', 
        error: 'Invalid post ID',
        failedShares: amount
      });
      return;
    }

    let successCount = 0;
    let failedCount = 0;
    let consecutiveFailures = 0;
    const maxRetries = 3;

    await saveProgress(sessionId, { status: 'in_progress' });

    const startTime = Date.now();
    let lastExecutionTime = startTime;

    for (let i = 0; i < amount; i++) {
      const now = Date.now();
      const elapsed = now - lastExecutionTime;
      const waitTime = Math.max(0, (interval * 1000) - elapsed);
      
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      lastExecutionTime = Date.now();
      
      let success = false;
      for (let retry = 0; retry < maxRetries; retry++) {
        success = await fbOperationLimiter.schedule(() => performShare(retrievedCookie, token, postId));
        if (success) break;
      }

      if (success) {
        successCount++;
        consecutiveFailures = 0;
      } else {
        failedCount++;
        consecutiveFailures++;
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`Session ${sessionId} reached ${MAX_CONSECUTIVE_FAILURES} consecutive failures - terminating`);
          await saveProgress(sessionId, {
            status: 'terminated',
            error: `Terminated due to ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
            completedShares: successCount,
            failedShares: failedCount
          });
          return;
        }
      }

      // Update progress every 5 shares or at the end
      if (i % 5 === 0 || i === amount - 1) {
        await saveProgress(sessionId, {
          completedShares: successCount,
          failedShares: failedCount
        });
      }
    }

    await saveProgress(sessionId, {
      status: 'completed',
      completedShares: successCount,
      failedShares: failedCount
    });
  } catch (error) {
    await saveProgress(sessionId, {
      status: 'failed',
      error: error.message,
      failedShares: amount
    });
  }
}

function apiResponse(res, status, message, data = null) {
  const response = {
    data: {
      status: status,
      message: message,
      developer: "Koudex",
      ...data
    }
  };
  return res.status(status).json(response);
}

// Queue processing
async function processQueue() {
  try {
    const queueSnapshot = await queueRef.once('value');
    const queue = queueSnapshot.val() || {};
    
    const activeSessions = await readSessions();
    const activeCount = Object.values(activeSessions)
      .filter(s => ['started', 'in_progress'].includes(s.status))
      .length;
    
    if (activeCount >= MAX_PARALLEL_SESSIONS * WORKER_COUNT) {
      return;
    }
    
    const nextSessionId = Object.keys(queue)[0];
    if (!nextSessionId) return;
    
    // Move from queue to active sessions
    const sessionData = queue[nextSessionId];
    await sessionsRef.child(nextSessionId).set(sessionData);
    await queueRef.child(nextSessionId).remove();
    
    // Start processing in a worker thread
    const worker = new Worker(__filename, {
      workerData: { sessionId: nextSessionId }
    });
    
    worker.on('error', (error) => {
      console.error(`Worker error for session ${nextSessionId}:`, error);
    });
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code} for session ${nextSessionId}`);
      }
    });
    
  } catch (error) {
    console.error('Queue processing error:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get("/api/v1/initial-data", checkHeader, async (req, res) => {
  try {
    const sessions = await readSessions();
    const now = Date.now();
    
    const activeSessions = Object.entries(sessions)
      .filter(([_, session]) => ['started', 'in_progress'].includes(session.status))
      .sort((a, b) => a[1].sessionNumber - b[1].sessionNumber)
      .map(([id, session]) => {
        const elapsedSeconds = (now - new Date(session.createdAt).getTime()) / 1000;
        const sharesPerSecond = session.completedShares / elapsedSeconds;
        const remainingShares = session.totalShares - (session.completedShares || 0);
        const estimatedTime = sharesPerSecond > 0 ? remainingShares / sharesPerSecond : Infinity;

        return {
          id,
          sessionNumber: session.sessionNumber,
          url: session.url,
          amount: session.totalShares,
          interval: session.interval,
          completed: session.completedShares || 0,
          failed: session.failedShares || 0,
          successRate: session.completedShares > 0 ? 
            ((session.completedShares / (session.completedShares + (session.failedShares || 0))) * 100).toFixed(2) : '0.00',
          startedAt: session.createdAt,
          estimatedTime: estimatedTime < Infinity ? 
            formatTime(estimatedTime) : 'Calculating...'
        };
      });

    const totalShares = Object.values(sessions).reduce((sum, s) => sum + (s.completedShares || 0), 0);
    const totalFailed = Object.values(sessions).reduce((sum, s) => sum + (s.failedShares || 0), 0);
    const successRate = totalShares > 0 ? 
      ((totalShares / (totalShares + totalFailed)) * 100).toFixed(2) : '0.00';

    res.json({
      data: {
        activeSessions,
        stats: {
          totalShares,
          successRate
        }
      }
    });
  } catch (error) {
    console.error('Error fetching initial data:', error);
    res.status(500).json({ error: 'Failed to fetch initial data' });
  }
});

app.post("/api/v1/submit", checkHeader, async (req, res) => {
  try {
    const { cookie, url, amount, interval } = req.body;
    
    if ((typeof cookie !== 'string' && !Array.isArray(cookie)) || 
        typeof url !== 'string' || 
        typeof amount !== 'number' || 
        typeof interval !== 'number') {
      return apiResponse(res, 400, "Invalid parameter types. Expected: cookie(string or array), url(string), amount(number), interval(number)");
    }

    let cookieString;
    try {
      if (Array.isArray(cookie)) {
        cookieString = convertJsonToCookieString(cookie);
      } else {
        try {
          const cookieJson = JSON.parse(cookie);
          cookieString = convertJsonToCookieString(cookieJson);
        } catch (e) {
          cookieString = cookie;
        }
      }
    } catch (error) {
      return apiResponse(res, 400, "Invalid cookie format. Must be either a valid JSON array or string format.");
    }

    const requiredCookieKeys = ['xs=', 'c_user=', 'fr=', 'datr='];
    const isValidCookie = requiredCookieKeys.some(key => cookieString.includes(key));
    if (!isValidCookie) {
      return apiResponse(res, 400, "Invalid Facebook cookie. Must contain authentication tokens.");
    }

    if (!url.match(/^https?:\/\/(www\.)?facebook\.com\/.+/i)) {
      return apiResponse(res, 400, "Invalid Facebook URL format. Must start with https://facebook.com/");
    }

    if (amount <= 0) {
      return apiResponse(res, 400, "Share amount must be at least 1 or greater than 0");
    }

    if (interval < 0.1 || interval > 60) {
      return apiResponse(res, 400, "Interval must be between 0.1 and 60 seconds");
    }

    if (interval < 1 && amount > 100) {
      return apiResponse(res, 400, "For intervals below 1 second, maximum shares is 100");
    }

    const sessionId = generateSessionId();
    const sessionNumber = await getNextSessionNumber();

    // Add to queue instead of starting immediately
    await queueRef.child(sessionId).set({
      status: 'queued',
      totalShares: Math.floor(amount),
      completedShares: 0,
      url: url.trim(),
      interval: parseFloat(interval.toFixed(1)),
      createdAt: new Date().toISOString(),
      sessionNumber,
      cookie: cookieString
    });

    return apiResponse(res, 200, "Sharing process queued successfully", {
      sessionId: sessionId,
      sessionNumber: sessionNumber
    });

  } catch (error) {
    console.error('Submit endpoint error:', error);
    return apiResponse(res, 500, "Internal server error", {
      error: error.message
    });
  }
});

// Initialize server
(async () => {
  console.log('Initializing Firebase session store');
  
  const sessions = await readSessions();
  let needsUpdate = false;
  
  for (const [id, session] of Object.entries(sessions)) {
    if (session.status === 'in_progress') {
      sessions[id].status = 'failed';
      sessions[id].error = 'Server restart interrupted this session';
      needsUpdate = true;
    }
  }
  
  if (needsUpdate) {
    await writeSessions(sessions);
  }

  // Check if we need to reset session counter when no active sessions exist
  const activeSessions = Object.values(sessions).filter(s => ['started', 'in_progress'].includes(s.status));
  if (activeSessions.length === 0) {
    const counterSnapshot = await counterRef.once('value');
    if (counterSnapshot.val() !== 0) {
      await counterRef.set(0);
      console.log('Reset session counter to 0 as no active sessions exist');
    }
  }

  // Start queue processing interval
  setInterval(processQueue, 5000);
  
  // Start workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    console.log(`Starting worker ${i + 1}`);
  }
})();

// Error handling
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Server shutting down...');
  process.exit();
});

module.exports = app;
