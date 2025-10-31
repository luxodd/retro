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

// EmulatorJS Configuration
EJS_player = "#game";
EJS_core = "{{CORE}}"; // Game console: gba, nes, snes, psx, n64, nds, etc.
EJS_gameName = "{{GAME_NAME}}"; // Game identifier
EJS_color = "#0064ff"; // Theme color
EJS_startOnLoaded = true;
EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
EJS_gameUrl = "{{GAME_FILE}}"; // ROM/ISO filename
{{LOAD_STATE_URL}}EJS_language = "en-US"; // Force English US locale

// Performance Optimizations
EJS_threads = typeof SharedArrayBuffer !== "undefined"; // Enable threading if supported

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

// EmulatorJS callbacks
const initGame = () => {
	gameLoaded = true;
	storeEmulator();
	startGameTimer();
};

EJS_onGameStart = initGame;
EJS_onLoadState = initGame;

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

const handleTimerExpired = () => {
	pauseGame();
	if (window.parent !== window) {
		window.parent.postMessage({ type: "session_options" }, "*");
	}
};

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
			handleTimerExpired();
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

// End session with reason
const endSession = (reason) => {
	isGameActive = false;
	clearInterval(timerInterval);
	clearInterval(healthCheckInterval);

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
			resumeGame();
		},
		restart: restartGame,
	};

	actions[action]?.();
};

// Initialize
window.addEventListener("message", handleMessage);
window.onload = () => {
	updateTimerDisplay();
	getGameToken();
};
