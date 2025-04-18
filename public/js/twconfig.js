tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                'sans': ['Inter var', 'ui-sans-serif', 'system-ui', '-apple-system'],
            },
            colors: {
                'dark-bg': '#0f172a',
                'dark-card': '#1e293b',
                'dark-text': '#e2e8f0',
                'dark-secondary': '#94a3b8',
                'dark-border': '#334155',
                'neon-blue': '#3b82f6',
                'neon-purple': '#8b5cf6',
                'neon-pink': '#ec4899',
                'neon-cyan': '#06b6d4',
                'brand-gradient': 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 50%, #ec4899 100%)'
            },
            boxShadow: {
                'glow-blue': '0 0 10px rgba(59, 130, 246, 0.7)',
                'glow-purple': '0 0 10px rgba(139, 92, 246, 0.7)',
                'glow-pink': '0 0 10px rgba(236, 72, 153, 0.7)',
                'glow-cyan': '0 0 10px rgba(6, 182, 212, 0.7)',
                'dark-inner': 'inset 0 2px 4px rgba(0, 0, 0, 0.3)'
            },
            backgroundImage: {
                'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
                'glass': 'linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0.9) 100%)'
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'float': 'float 6s ease-in-out infinite',
                'neon-flicker': 'neon-flicker 1.5s infinite alternate',
                'neon-pulse': 'neon-pulse 2s infinite'
            },
            keyframes: {
                float: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-10px)' }
                },
                'neon-flicker': {
                    '0%, 19%, 21%, 23%, 25%, 54%, 56%, 100%': {
                        'text-shadow': `
                            0 0 4px #fff,
                            0 0 11px #fff,
                            0 0 19px #fff,
                            0 0 40px #3b82f6,
                            0 0 80px #3b82f6,
                            0 0 90px #3b82f6,
                            0 0 100px #3b82f6,
                            0 0 150px #3b82f6
                        `,
                        'box-shadow': `
                            0 0 5px rgba(59, 130, 246, 0.3),
                            0 0 10px rgba(59, 130, 246, 0.2),
                            0 0 15px rgba(59, 130, 246, 0.1),
                            0 0 20px rgba(59, 130, 246, 0.1)
                        `
                    },
                    '20%, 24%, 55%': {
                        'text-shadow': 'none',
                        'box-shadow': 'none'
                    }
                },
                'neon-pulse': {
                    '0%, 100%': {
                        opacity: '1'
                    },
                    '50%': {
                        opacity: '0.5'
                    }
                }
            }
        }
    }
}
