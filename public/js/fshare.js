// Initialize Lucide icons
lucide.createIcons();

// Set current year in footer
// document.getElementById('year').textContent = new Date().getFullYear();

// Sidebar toggle functionality
const sidebar = document.getElementById('sidebar');
//const sidebarToggle = document.getElementById('sidebarToggle');
const mobileSidebarToggle = document.getElementById('mobileSidebarToggle');
const sidebarOverlay = document.createElement('div');
sidebarOverlay.id = 'sidebarOverlay';
document.body.appendChild(sidebarOverlay);

function toggleSidebar() {
    sidebar.classList.toggle('sidebar-open');
    sidebarOverlay.classList.toggle('active');
}

//sidebarToggle.addEventListener('click', toggleSidebar);
mobileSidebarToggle.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', toggleSidebar);

// Navigation functionality
const navLinks = document.querySelectorAll('.nav-link');
const sections = {
    'home': document.getElementById('home-section'),
    'sessions': document.getElementById('sessions-section'),
    'stats': document.getElementById('stats-section'),
    'guide': document.getElementById('guide-section')
};
const pageTitle = document.getElementById('pageTitle');

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const section = link.dataset.section;
        
        // Update active nav link
        navLinks.forEach(navLink => navLink.classList.remove('active'));
        link.classList.add('active');
        
        // Update page title
        pageTitle.textContent = link.querySelector('span').textContent;
        
        // Show selected section
        Object.values(sections).forEach(sec => sec.classList.add('hidden'));
        sections[section].classList.remove('hidden');
        
        // Close sidebar on mobile
        if (window.innerWidth < 1024) {
            toggleSidebar();
        }
    });
});

// Form validation and button state
const form = document.getElementById('shareForm');
const inputs = form.querySelectorAll('input, textarea');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');

function checkFormValidity() {
    let allValid = true;
    inputs.forEach(input => {
        if (!input.checkValidity()) {
            allValid = false;
        }
    });
    
    submitBtn.disabled = !allValid;
    btnText.textContent = allValid ? 'Start Boosting' : 'Fill all fields';
    
    if (allValid) {
        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        submitBtn.classList.add('hover:opacity-90', 'active:scale-[0.98]');
    } else {
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
        submitBtn.classList.remove('hover:opacity-90', 'active:scale-[0.98]');
    }
}

inputs.forEach(input => {
    input.addEventListener('input', checkFormValidity);
});

// Initialize form validation
checkFormValidity();

// Form submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = new FormData(form);
    const data = {
        cookie: formData.get('cookie'),
        url: formData.get('url'),
        amount: parseInt(formData.get('amount')),
        interval: parseFloat(formData.get('interval'))
    };
    
    try {
        submitBtn.disabled = true;
        btnText.textContent = 'Processing...';
        
        const response = await axios.post('/api/v1/submit', data);
        const result = response.data.data;
        
        await Swal.fire({
            icon: 'success',
            title: 'Session Started',
            text: `Your sharing session has been started successfully (ID: ${result.id})`,
            background: '#1e293b',
            color: '#e2e8f0',
            confirmButtonColor: '#3b82f6',
            iconColor: '#10b981'
        });
        
        // Clear form after successful submission
        form.reset();
        checkFormValidity();
        
    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.data && error.response.data.message) {
            errorMessage = error.response.data.message;
        }
        
        await Swal.fire({
            icon: 'error',
            title: 'Failed Starting Session',
            text: errorMessage,
            background: '#1e293b',
            color: '#e2e8f0',
            confirmButtonColor: '#3b82f6',
            iconColor: '#ef4444'
        });
    } finally {
        submitBtn.disabled = false;
        btnText.textContent = 'Start Boosting';
        checkFormValidity();
    }
});

// WebSocket and session management
let activeSessions = [];
let stats = { totalShares: 0, successRate: 0 };
let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
const POLL_INTERVAL = 5000;

function loadInitialData() {
    const savedData = localStorage.getItem('fshare_sessions');
    if (savedData) {
        try {
            const parsedData = JSON.parse(savedData);
            activeSessions = parsedData.activeSessions || [];
            stats = parsedData.stats || { totalShares: 0, successRate: 0 };
            updateSessionsUI();
            updateStatsUI();
        } catch (err) {
            console.error('Failed to parse saved data:', err);
        }
    }
}

function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
        fetchInitialData();
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'sessions_update') {
            activeSessions = message.data.activeSessions;
            stats = message.data.stats;
            localStorage.setItem('fshare_sessions', JSON.stringify({
                activeSessions,
                stats
            }));
            updateSessionsUI();
            updateStatsUI();
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(initWebSocket, RECONNECT_DELAY);
        } else {
            console.log('Max reconnection attempts reached. Starting polling...');
            startPolling();
        }
    };
}

let pollingInterval;

function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(fetchInitialData, POLL_INTERVAL);
    fetchInitialData();
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

async function fetchInitialData() {
    try {
        const response = await axios.get('/api/v1/initial-data');
        const data = response.data.data;
        activeSessions = data.activeSessions;
        stats = data.stats;
        localStorage.setItem('fshare_sessions', JSON.stringify({
            activeSessions,
            stats
        }));
        updateSessionsUI();
        updateStatsUI();
    } catch (error) {
        console.error('Failed to fetch initial data:', error);
    }
}

function updateSessionsUI() {
    const sessionsContainer = document.getElementById('sessions');
    
    if (activeSessions.length === 0) {
        sessionsContainer.innerHTML = `
            <div class="bg-dark-bg/50 rounded-lg p-4 border border-dark-border/30 text-center text-dark-secondary">
                <i data-lucide="server-off" class="w-6 h-6 mx-auto mb-2 text-dark-secondary"></i>
                <p>No active sessions found</p>
            </div>
        `;
    } else {
        sessionsContainer.innerHTML = activeSessions.map(session => `
            <div class="bg-dark-bg/50 rounded-lg p-4 border border-dark-border/30">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${session.status === 'active' ? 'bg-green-400 animate-pulse' : 'bg-red-400'}"></span>
                        <span class="text-sm font-medium">Session #${session.sessionNumber}</span>
                    </div>
                    <span class="text-xs px-2 py-1 rounded ${session.status === 'active' ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}">
                        ${session.status === 'active' ? 'Active' : 'Inactive'}
                    </span>
                </div>
                <div class="grid grid-cols-2 gap-2 text-xs text-dark-secondary mb-3">
                    <div class="truncate">
                        <span class="font-medium">URL:</span> ${session.url}
                    </div>
                    <div>
                        <span class="font-medium">Progress:</span> ${session.completed}/${session.amount}
                    </div>
                </div>
                <div class="space-y-2">
                    <div class="flex justify-between text-xs">
                        <span>${Math.round((session.completed / session.amount) * 100)}%</span>
                        <span>ETA: ${session.estimatedTime || 'Calculating...'}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-bar-fill" style="width: ${Math.round((session.completed / session.amount) * 100)}%"></div>
                    </div>
                </div>
            </div>
        `).join('');
    }
    
    lucide.createIcons();
}

function updateStatsUI() {
    document.getElementById('totalShares').textContent = stats.totalShares;
    document.getElementById('successRate').textContent = `${stats.successRate}%`;
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    loadInitialData();
    initWebSocket();
    
    // Show home section by default
    document.querySelector('.nav-link[data-section="home"]').click();
});

// Handle window resize for sidebar
window.addEventListener('resize', () => {
    if (window.innerWidth >= 1024) {
        sidebar.classList.remove('sidebar-open');
        sidebarOverlay.classList.remove('active');
    }
});

// Handle session completion notifications
function checkForCompletedSessions(newSessions, oldSessions) {
    const completedSessions = newSessions.filter(newSession => {
        const oldSession = oldSessions.find(s => s.id === newSession.id);
        return newSession.status === 'completed' && 
               (!oldSession || oldSession.status !== 'completed');
    });

    completedSessions.forEach(session => {
        Swal.fire({
            icon: 'success',
            title: 'Session Completed',
            html: `Session #${session.sessionNumber} has completed successfully<br>
                   <small>${session.completed} shares completed</small>`,
            background: '#1e293b',
            color: '#e2e8f0',
            confirmButtonColor: '#3b82f6',
            iconColor: '#10b981'
        });
    });
}

// Handle failed session notifications
function checkForFailedSessions(newSessions, oldSessions) {
    const failedSessions = newSessions.filter(newSession => {
        const oldSession = oldSessions.find(s => s.id === newSession.id);
        return (newSession.status === 'failed' || newSession.status === 'terminated') && 
               (!oldSession || oldSession.status === 'active');
    });

    failedSessions.forEach(session => {
        Swal.fire({
            icon: 'error',
            title: `Session ${session.status === 'terminated' ? 'Terminated' : 'Failed'}`,
            html: `Session #${session.sessionNumber} has ${session.status === 'terminated' ? 'been terminated' : 'failed'}<br>
                   <small>${session.error || 'Unknown error'}</small>`,
            background: '#1e293b',
            color: '#e2e8f0',
            confirmButtonColor: '#3b82f6',
            iconColor: '#ef4444'
        });
    });
}

// Store previous sessions for comparison
let previousSessions = [];

// Modify the WebSocket message handler to include notifications
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'sessions_update') {
        // Check for completed/failed sessions before updating
        checkForCompletedSessions(message.data.activeSessions, previousSessions);
        checkForFailedSessions(message.data.activeSessions, previousSessions);
        
        // Update sessions data
        activeSessions = message.data.activeSessions;
        stats = message.data.stats;
        localStorage.setItem('fshare_sessions', JSON.stringify({
            activeSessions,
            stats
        }));
        
        // Update UI
        updateSessionsUI();
        updateStatsUI();
        
        // Store current sessions for next comparison
        previousSessions = [...activeSessions];
    }
};