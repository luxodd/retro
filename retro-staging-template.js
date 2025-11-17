// ============================================
// GAME CONFIGURATION - EDIT THIS SECTION ONLY
// ============================================
const GAME_TIMER_SECONDS = (() => {
	const urlParams = new URLSearchParams(window.location.search);
	const timeout = urlParams.get("timeout");
	return timeout && !isNaN(timeout) && parseInt(timeout) > 0
		? parseInt(timeout)
		: null;
})();
const WARNING_THRESHOLD = 30; // Show warning when timer reaches this value

// Enable death-triggered end-of-session if URL includes ?deaths=true|1|yes
const DEATHS_ENABLED = (() => {
	const urlParams = new URLSearchParams(window.location.search);
	const v = (urlParams.get("deaths") || "").toLowerCase();
	return v === "1" || v === "true" || v === "yes";
})();
window.DEATHS_ENABLED = DEATHS_ENABLED;
console.log('[RetroTemplate] DEATHS_ENABLED =', DEATHS_ENABLED);

// EmulatorJS Configuration
EJS_player = "#game";
EJS_core = "{{CORE}}"; // Game console: gba, nes, snes, psx, n64, nds, etc.
EJS_gameName = "{{GAME_NAME}}"; // Game identifier (display name)
EJS_gameID = "{{GAME_ID}}"; // Actual database UUID for API calls
EJS_color = "#0064ff"; // Theme color
EJS_startOnLoaded = true;
EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
EJS_gameUrl = "{{GAME_FILE}}"; // ROM/ISO filename
{{LOAD_STATE_URL}}EJS_language = "en-US"; // Force English US locale

// Performance Optimizations
EJS_threads = typeof SharedArrayBuffer !== "undefined"; // Enable threading if supported

// ============================================
// AUTO-SAVE CONFIGURATION
// ============================================
const AUTO_SAVE_CONFIG = {
	enabled: true,
	saveIntervalSeconds: 30,
	serverUrl: window.location.origin,
	enableDebugLogs: true,
	showNotifications: false
};

let autoSaveTimer = null;
let saveInProgress = false;
let lastSaveTimestamp = null;

// ============================================
// END CONFIGURATION
// ============================================

// Timer variables
let gameTimer = GAME_TIMER_SECONDS;
let timerInterval;
let gameToken;
let timerStarted = false;
let gameLoaded = false;

// WebSocket and health check variables
let websocket;
let healthCheckInterval;
let healthCheckFailures = 0;
const maxHealthCheckFailures = 3;
let isGameActive = true;

// Cache DOM elements
const timerOverlay = document.getElementById("timer-overlay");
const gameContainer = document.querySelector("#game");

// Helper: Get emulator instance
const getEmulator = () => window.EJS_emulator || gameContainer?.ej;

// Helper: Store emulator instance
const storeEmulator = () => {
	if (typeof EmulatorJS !== "undefined" && gameContainer?.ej) {
		window.EJS_emulator = gameContainer.ej;
	}
};

// ============================================
// AUTO-SAVE HELPER FUNCTIONS
// ============================================
const log = (...args) => {
	if (AUTO_SAVE_CONFIG.enableDebugLogs) {
		console.log('[AutoSave]', ...args);
	}
};

const getGameId = () => {
	// 1. Use the actual database UUID if provided via template
	if (typeof EJS_gameID !== 'undefined' && EJS_gameID) {
		return EJS_gameID;
	}
	
	// 2. Try to extract UUID from current URL path (e.g., /proxy/{uuid}/index.html)
	try {
		const urlPath = window.location.pathname;
		// Match UUID pattern in URL: /proxy/{uuid}/ or /{uuid}/
		const uuidRegex = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
		const match = urlPath.match(uuidRegex);
		if (match && match[1]) {
			log(`Extracted gameID from URL: ${match[1]}`);
			return match[1];
		}
	} catch (error) {
		log('Error extracting gameID from URL:', error);
	}
	
	// 3. Fallback to sanitized name for backwards compatibility
	if (!EJS_gameName) return null;
	const sanitized = EJS_gameName.toLowerCase().replace(/[^a-z0-9]/g, '-');
	log(`Using fallback gameID (sanitized name): ${sanitized}`);
	return sanitized;
};

const getAuthToken = () => gameToken;

// Helper: Convert Uint8Array to base64 (handles large arrays)
const uint8ArrayToBase64 = (uint8Array) => {
	// For large arrays, process in chunks to avoid stack overflow
	const chunkSize = 32768; // 32KB chunks
	let binary = '';
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return 'data:application/octet-stream;base64,' + btoa(binary);
};

// Helper: Convert base64 to Uint8Array
const base64ToUint8Array = (base64) => {
	// Remove data URL prefix if present
	const base64Data = base64.replace(/^data:application\/octet-stream;base64,/, '');
	const binaryString = atob(base64Data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
};

// Save current game state to backend (FIXED VERSION)
const saveStateToBackend = async () => {
	if (!AUTO_SAVE_CONFIG.enabled) return;
	if (saveInProgress) {
		log('Save already in progress, skipping');
		return;
	}

	const token = getAuthToken();
	const gameId = getGameId();
	const emulator = getEmulator();

	if (!token) {
		log('No auth token, cannot save');
		return;
	}

	if (!gameId) {
		log('No game ID, cannot save');
		return;
	}

	if (!emulator || !emulator.gameManager) {
		log('Emulator not ready, cannot save');
		return;
	}

	saveInProgress = true;
	log(`Saving state for game: ${gameId}`);
	log(`Using auth token (length: ${token?.length || 0}):`, token ? token.substring(0, 20) + '...' : 'MISSING');

	try {
		// THE FIX: Use getState() instead of saveState() - returns Uint8Array
		const stateData = emulator.gameManager.getState();

		if (!stateData || stateData.length === 0) {
			log('Empty state data, skipping save');
			return;
		}

		// Convert Uint8Array to base64
		const base64Data = uint8ArrayToBase64(stateData);

		log(`Sending save request to: ${AUTO_SAVE_CONFIG.serverUrl}/api/v1/game-state/save?gameID=${encodeURIComponent(gameId)}`);
		
		const response = await fetch(
			`${AUTO_SAVE_CONFIG.serverUrl}/api/v1/game-state/save?gameID=${encodeURIComponent(gameId)}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`
				},
				body: JSON.stringify({
					stateData: base64Data,
					compression: 'none'
				})
			}
		);

		log(`Save response status: ${response.status}`);
		
		if (!response.ok) {
			const errorText = await response.text();
			log(`Save error response body:`, errorText);
			throw new Error(`Save failed: ${response.status} - ${errorText}`);
		}

		const result = await response.json();
		lastSaveTimestamp = Date.now();
		log('State saved successfully:', result);

	} catch (error) {
		console.error('[AutoSave] Error:', error);
	} finally {
		saveInProgress = false;
	}
};

// Load saved game state from backend (IMPROVED)
const loadStateFromBackend = async () => {
	if (!AUTO_SAVE_CONFIG.enabled) return null;

	const token = getAuthToken();
	const gameId = getGameId();

	if (!gameId) {
		log('No game ID, cannot load');
		return null;
	}

	log(`Loading state for game: ${gameId}`);
	log(`Using auth token for load (length: ${token?.length || 0}):`, token ? token.substring(0, 20) + '...' : 'MISSING');

	try {
		const url = new URL(`${AUTO_SAVE_CONFIG.serverUrl}/api/v1/game-state/load`);
		url.searchParams.set('gameID', gameId);

		const headers = {};
		if (token) {
			headers['Authorization'] = `Bearer ${token}`;
		}

		log(`Loading from URL: ${url.toString()}`);
		
		const response = await fetch(url.toString(), {
			method: 'GET',
			headers: headers
		});
		
		log(`Load response status: ${response.status}`);

		if (response.status === 404) {
			log('No saved state found (starting fresh)');
			return null;
		}

		if (!response.ok) {
			throw new Error(`Load failed: ${response.status}`);
		}

		// Backend returns raw binary data, not JSON
		const arrayBuffer = await response.arrayBuffer();
		const stateData = new Uint8Array(arrayBuffer);
		
		log('State loaded successfully, size:', stateData.length);
		return stateData;
	} catch (error) {
		console.error('[AutoSave] Load error:', error);
		return null;
	}
};

// Start periodic auto-save
const startAutoSave = () => {
	if (!AUTO_SAVE_CONFIG.enabled) return;

	if (autoSaveTimer) {
		clearInterval(autoSaveTimer);
	}

	log(`Starting auto-save (every ${AUTO_SAVE_CONFIG.saveIntervalSeconds}s)`);
	
	autoSaveTimer = setInterval(() => {
		saveStateToBackend();
	}, AUTO_SAVE_CONFIG.saveIntervalSeconds * 1000);
};


const stopAutoSave = () => {
	if (autoSaveTimer) {
		clearInterval(autoSaveTimer);
		autoSaveTimer = null;
		log('Auto-save stopped');
	}
};
	

// ============================================
// GAME INITIALIZATION (MODIFIED)
// ============================================

// EmulatorJS callbacks
const initGame = async () => {
	gameLoaded = true;
	storeEmulator();

	// Try to load saved state before starting timer
	const savedState = await loadStateFromBackend();
	if (savedState) {
		try {
			const emulator = getEmulator();
			if (emulator && emulator.gameManager) {
				log('Restoring saved state...');
				// Use loadState() with Uint8Array
				emulator.gameManager.loadState(savedState);
				log('State restored!');
			}
		} catch (error) {
			console.error('[AutoSave] Failed to restore state:', error);
			log('Starting fresh game instead');
		}
	}

	startGameTimer();
	startAutoSave();
};

EJS_onGameStart = initGame;
EJS_onLoadState = initGame;

// Hook into manual saves - when user presses save button in emulator
EJS_onSaveUpdate = function(event) {
	log('Manual save detected!');
	// Sync manual saves to backend immediately
	if (AUTO_SAVE_CONFIG.enabled) {
		saveStateToBackend();
	}
};

// Fallback function to detect when game is ready
const checkGameReady = () => {
	// Look for canvas element and check if it has content
	const canvas = document.querySelector("#game canvas");
	if (canvas && canvas.width > 0 && canvas.height > 0) {
		if (!gameLoaded) {
			gameLoaded = true;
			storeEmulator();
			startGameTimer();
		}
		return true;
	}
	return false;
};

// Timer functions
const updateTimerDisplay = () => {
	if (!GAME_TIMER_SECONDS) {
		timerOverlay.style.display = "none";
		return;
	}
	timerOverlay.style.display = "block";
	const minutes = Math.floor(gameTimer / 60);
	const seconds = gameTimer % 60;
	timerOverlay.textContent = `Time Remaining: ${minutes}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

// Universal end-of-session trigger (formerly handleTimerExpired)
const inGameTrx = () => {
	console.log('[RetroTemplate] inGameTrx() invoked');
	pauseGame();
	if (window.parent !== window) {
		window.parent.postMessage({ type: "session_options" }, "*");
	}
};
// Expose globally so game-specific pages can trigger it (e.g., death/continues exhausted)
window.inGameTrx = inGameTrx;

const startGameTimer = () => {
	if (!GAME_TIMER_SECONDS || timerStarted) return;

	timerStarted = true;
	timerInterval = setInterval(() => {
		gameTimer--;
		updateTimerDisplay();

		if (gameTimer <= WARNING_THRESHOLD) {
			timerOverlay.classList.add("warning");
		}

		if (gameTimer <= 0) {
			clearInterval(timerInterval);
			console.log('[RetroTemplate] Timer expired -> inGameTrx()');
			inGameTrx();
		}
	}, 1000);
};

const resetTimer = () => {
	if (!GAME_TIMER_SECONDS) return;

	// Clear any existing timer interval to prevent multiple intervals
	if (timerInterval) {
		clearInterval(timerInterval);
	}

	gameTimer = GAME_TIMER_SECONDS;
	timerStarted = false;
	timerOverlay.classList.remove("warning");
	updateTimerDisplay();
	startGameTimer();
};

// Game control functions
const pauseGame = () => {
	const emulator = getEmulator();
	if (emulator?.pause) {
		emulator.pause();
		return true;
	}
	storeEmulator();
	const retryEmulator = getEmulator();
	if (retryEmulator?.pause) {
		retryEmulator.pause();
		return true;
	}
	return false;
};

const resumeGame = () => {
	const emulator = getEmulator();
	if (emulator?.play) {
		emulator.play();
		return true;
	}
	storeEmulator();
	const retryEmulator = getEmulator();
	if (retryEmulator?.play) {
		retryEmulator.play();
		return true;
	}
	return false;
};

const restartGame = () => window.location.reload();

// Token management
const getGameToken = () => {
	const urlParams = new URLSearchParams(window.location.search);
	let token = urlParams.get("token");

	if (!token) {
		// Try to get token from parent window message
		window.addEventListener("message", function (event) {
			if (event.data && event.data.jwt) {
				token = event.data.jwt;
				gameToken = token;
				initializeWebSocket();
			}
		});
	} else {
		gameToken = token;
		initializeWebSocket();
	}

	return token;
};

// WebSocket initialization
const initializeWebSocket = () => {
	if (!gameToken) {
		console.error("No game token available");
		return;
	}

	// Get the parent window's origin for WebSocket connection
	let serverHost;
	try {
		serverHost = window.parent.location.host;
	} catch (e) {
		// Fallback: extract from referrer or use default
		if (document.referrer) {
			const referrerUrl = new URL(document.referrer);
			serverHost = referrerUrl.host;
		} else {
			serverHost = window.location.hostname + ":8080";
		}
	}

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${protocol}//${serverHost}/ws?token=${gameToken}`;

	websocket = new WebSocket(wsUrl);

	websocket.onopen = function (event) {
		startHealthCheck();
	};

	websocket.onmessage = function (event) {
		const message = JSON.parse(event.data);
		handleWebSocketMessage(message);
	};

	websocket.onclose = function (event) {
		// Only count failures after game has loaded
		if (gameLoaded) {
			healthCheckFailures++;

			if (healthCheckFailures >= maxHealthCheckFailures) {
				endSession("Connection lost");
				return;
			}
		}

		if (isGameActive) {
			// Try to reconnect after 5 seconds
			setTimeout(initializeWebSocket, 5000);
		}
	};

	websocket.onerror = function (error) {
		// Only count failures after game has loaded
		if (gameLoaded) {
			healthCheckFailures++;

			if (healthCheckFailures >= maxHealthCheckFailures) {
				endSession("Connection error");
			}
		}
	};
};

// Handle WebSocket messages
const handleWebSocketMessage = (message) => {
	switch (message.type) {
		case "health_status_check_response":
			// Reset health check failures on successful response
			healthCheckFailures = 0;
			break;
	}
};

// Send WebSocket message
const sendWebSocketMessage = (type, payload = null) => {
	if (websocket && websocket.readyState === WebSocket.OPEN) {
		const message = {
			msgver: "1",
			type: type,
			ts: new Date().toISOString(),
			status: 200,
		};

		// Only include payload if it's not null
		if (payload !== null) {
			message.payload = payload;
		}

		websocket.send(JSON.stringify(message));
	}
};

// Start health check
const startHealthCheck = () => {
	healthCheckInterval = setInterval(function () {
		if (isGameActive) {
			sendWebSocketMessage("health_status_check", {});
		}
	}, 30000); // Send health check every 30 seconds
};

// End session with reason (MODIFIED - added auto-save)
const endSession = async (reason) => {
	isGameActive = false;
	
	// Save one final time before ending
	await saveStateToBackend();
	
	clearInterval(timerInterval);
	clearInterval(healthCheckInterval);
	stopAutoSave();

	if (websocket) {
		websocket.close();
	}

	// Send message to parent window to redirect
	if (window.parent !== window) {
		window.parent.postMessage({ type: "session_end", reason: reason }, "*");
	} else {
		window.location.href = "/selectGame";
	}
};

// Message handlers
const handleMessage = (event) => {
	if (!event.data) return;

	// Handle JWT token
	if (event.data.jwt) {
		gameToken = event.data.jwt;
		return;
	}

	// Handle action messages
	const { action } = event.data;
	if (!action) return;

	const actions = {
		end: () => endSession("User ended session"),
		continue: () => {
			resetTimer();
			// Ensure we target the current live emulator instance
			storeEmulator();
			resumeGame();
			// Minimal safety: try once more shortly after overlays settle
			setTimeout(() => { storeEmulator(); resumeGame(); }, 200);
		},
		restart: restartGame,
	};

	actions[action]?.();
};

// Initialize
window.addEventListener("message", handleMessage);
window.addEventListener('beforeunload', () => {
	stopAutoSave();
});
window.onload = () => {
	updateTimerDisplay();
	getGameToken();
};
