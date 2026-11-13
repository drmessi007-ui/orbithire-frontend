const CONTRACT_ID = "orbit-hire.shortemail369.testnet";
const NETWORK_ID = "testnet";
const RPC_URL = "https://rpc.testnet.near.org";
const AGENT_API_URL = "https://agent.deosorno.cl";
const FEE_YOCTO = "100000000000000000000000";
const REQUEST_GAS = "100000000000000";
const EXPLORER_URL = "https://explorer.testnet.near.org/transactions/";
const RESULT_POLL_INTERVAL_MS = 2500;
const RESULT_POLL_ATTEMPTS = 48;
const AGENT_HEALTH_POLL_INTERVAL_MS = 30000;
const REQUEST_RATE_LIMIT_MS = 60 * 60 * 1000;
const REQUEST_COOLDOWN_STORAGE_PREFIX = "orbithire:request-cooldown:";
const REQUEST_HISTORY_STORAGE_PREFIX = "orbithire:request-history:";
const MAX_HISTORY_ENTRIES = 100;
const HISTORY_STATUSES = new Set(["pending", "completed", "failed", "under_review"]);

const walletButton = document.querySelector("#wallet-button");
const submitButton = document.querySelector("#submit-button");
const queryInput = document.querySelector("#query");
const charCount = document.querySelector("#char-count");
const agentApiNote = document.querySelector("#agent-api-note");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const resultContent = document.querySelector("#result-content");
const resultCopy = document.querySelector("#result-copy");
const requestIdLabel = document.querySelector("#request-id");
const transactionLink = document.querySelector("#transaction-link");
const historyWallet = document.querySelector("#history-wallet");
const historyStorageNote = document.querySelector("#history-storage-note");
const historyEmpty = document.querySelector("#history-empty");
const historyList = document.querySelector("#history-list");

let walletSelector;
let meteorWallet;
let walletReady = false;
let actionCreators;
let setupWalletSelector;
let setupMeteorWallet;
let isSubmitting = false;
let agentHealthReady = false;
let agentHealthCheckInProgress = false;
let agentHealthCheckPromise;
const inMemoryRequestCooldowns = new Map();
const requestHistoryCache = new Map();
const historyStorageErrors = new Map();
const agentApiConfigured = isValidAgentApiUrl();

function isValidAgentApiUrl() {
  try {
    const url = new URL(AGENT_API_URL);
    return url.protocol === "https:" && !url.hostname.endsWith(".example.com");
  } catch {
    return false;
  }
}

function showStatus(message, state = "idle") {
  statusLabel.textContent = message;
  statusLabel.dataset.state = state;
}

function showMessage(message, requestId = "", transactionHash = "") {
  emptyState.hidden = true;
  resultContent.hidden = false;
  resultCopy.textContent = message;
  requestIdLabel.textContent = requestId || "—";
  if (transactionHash) {
    transactionLink.href = `${EXPLORER_URL}${encodeURIComponent(transactionHash)}`;
    transactionLink.hidden = false;
  } else {
    transactionLink.removeAttribute("href");
    transactionLink.hidden = true;
  }
}

function getRequestCooldownUntil(accountId) {
  if (!accountId) return 0;

  const memoryCooldown = inMemoryRequestCooldowns.get(accountId) || 0;
  try {
    const storedCooldown = Number(
      window.localStorage.getItem(`${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`),
    );
    if (Number.isFinite(storedCooldown) && storedCooldown > Date.now()) {
      return Math.max(memoryCooldown, storedCooldown);
    }
    window.localStorage.removeItem(`${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`);
  } catch (error) {
    console.warn("No se pudo leer el límite local de solicitudes:", error);
  }
  return memoryCooldown > Date.now() ? memoryCooldown : 0;
}

function recordRequestCooldown(accountId) {
  const cooldownUntil = Date.now() + REQUEST_RATE_LIMIT_MS;
  inMemoryRequestCooldowns.set(accountId, cooldownUntil);
  try {
    window.localStorage.setItem(
      `${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`,
      String(cooldownUntil),
    );
  } catch (error) {
    console.warn("No se pudo guardar el límite local de solicitudes:", error);
  }
}

function formatCooldown(remainingMs) {
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return remainingSeconds >= 60
    ? `${Math.ceil(remainingSeconds / 60)} min`
    : `${remainingSeconds} s`;
}

function getRequestHistory(accountId) {
  if (!accountId) return [];
  if (requestHistoryCache.has(accountId)) {
    return requestHistoryCache.get(accountId);
  }

  try {
    const stored = window.localStorage.getItem(
      `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`,
    );
    const entries = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(entries)) {
      throw new Error("El formato del historial local no es válido.");
    }
    const history = entries.filter(
      (entry) =>
        entry &&
        entry.wallet === accountId &&
        typeof entry.requestId === "string" &&
        typeof entry.query === "string" &&
        HISTORY_STATUSES.has(entry.status) &&
        typeof entry.date === "string",
    );
    requestHistoryCache.set(accountId, history);
    historyStorageErrors.delete(accountId);
    return history;
  } catch (error) {
    console.error("No se pudo leer el historial local:", error);
    requestHistoryCache.set(accountId, []);
    historyStorageErrors.set(accountId, "No se pudo leer el historial local de esta wallet.");
    return [];
  }
}

function saveRequestHistory(accountId, entries) {
  const sortedEntries = entries
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
    .slice(0, MAX_HISTORY_ENTRIES);
  requestHistoryCache.set(accountId, sortedEntries);
  try {
    window.localStorage.setItem(
      `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`,
      JSON.stringify(sortedEntries),
    );
    historyStorageErrors.delete(accountId);
    return true;
  } catch (error) {
    console.error("No se pudo guardar el historial local:", error);
    historyStorageErrors.set(accountId, "No se pudo guardar en este navegador; el historial solo se conserva en esta sesión.");
    return false;
  }
}

function renderHistory(accountId) {
  historyList.replaceChildren();
  historyStorageNote.hidden = true;
  historyEmpty.hidden = false;
  historyList.hidden = true;

  if (!accountId) {
    historyWallet.textContent = "Conecta una wallet para ver su historial";
    historyEmpty.textContent = "Las consultas de la wallet conectada aparecerán aquí.";
    return;
  }

  historyWallet.textContent = accountId;
  const entries = getRequestHistory(accountId);
  const storageError = historyStorageErrors.get(accountId);
  if (storageError) {
    historyStorageNote.textContent = storageError;
    historyStorageNote.hidden = false;
  }
  if (entries.length === 0) {
    historyEmpty.textContent = "Esta wallet todavía no tiene consultas guardadas en este navegador.";
    return;
  }

  historyEmpty.hidden = true;
  historyList.hidden = false;
  const statusLabels = {
    pending: "Pendiente",
    completed: "Completada",
    failed: "Fallida",
    under_review: "En revisión",
  };
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-entry";

    const header = document.createElement("div");
    header.className = "history-entry-header";
    const status = document.createElement("span");
    status.className = "history-status";
    status.dataset.state = entry.status;
    status.textContent = statusLabels[entry.status];
    const date = document.createElement("time");
    date.className = "history-date";
    date.dateTime = entry.date;
    const parsedDate = new Date(entry.date);
    date.textContent = Number.isNaN(parsedDate.getTime())
      ? entry.date
      : parsedDate.toLocaleString();
    header.append(status, date);

    const query = document.createElement("p");
    query.className = "history-query";
    query.textContent = entry.query;

    const requestId = document.createElement("p");
    requestId.className = "history-id";
    requestId.textContent = `Request ID: ${entry.requestId}`;
    item.append(header, query, requestId);

    if (entry.transactionHash) {
      const transaction = document.createElement("a");
      transaction.className = "history-transaction";
      transaction.href = `${EXPLORER_URL}${encodeURIComponent(entry.transactionHash)}`;
      transaction.target = "_blank";
      transaction.rel = "noopener noreferrer";
      transaction.textContent = "Ver transacción en NEAR Explorer";
      item.append(transaction);
    }
    historyList.append(item);
  }
}

function updateHistoryEntry(accountId, requestId, changes) {
  const entries = getRequestHistory(accountId);
  const index = entries.findIndex((entry) => entry.requestId === requestId);
  if (index === -1) return;

  entries[index] = { ...entries[index], ...changes, wallet: accountId, requestId };
  saveRequestHistory(accountId, entries);
  if (walletSelector?.isSignedIn()) {
    const activeAccountId = walletSelector.store.getState().accounts[0]?.accountId;
    if (activeAccountId === accountId) renderHistory(accountId);
  }
}

function addHistoryEntry(entry) {
  const entries = getRequestHistory(entry.wallet);
  entries.push(entry);
  saveRequestHistory(entry.wallet, entries);
  renderHistory(entry.wallet);
}

function updateWalletUi() {
  const signedIn = Boolean(walletSelector?.isSignedIn());
  const accountId = signedIn
    ? walletSelector.store.getState().accounts[0]?.accountId
    : "";
  renderHistory(accountId);
  const cooldownUntil = getRequestCooldownUntil(accountId);
  const cooldownRemaining = Math.max(0, cooldownUntil - Date.now());
  walletButton.disabled = !walletReady;
  submitButton.disabled =
    !signedIn ||
    !agentApiConfigured ||
    !agentHealthReady ||
    agentHealthCheckInProgress ||
    cooldownRemaining > 0 ||
    isSubmitting;
  if (signedIn) {
    const connectedAccountId = accountId || "Wallet conectada";
    walletButton.textContent = `${connectedAccountId.slice(0, 11)}… · Salir`;
  } else {
    walletButton.textContent = "Conectar Meteor Wallet";
  }
  if (cooldownRemaining > 0) {
    agentApiNote.textContent =
      `Esta cuenta ya envió una solicitud. El contrato permite una por hora; podrás pagar de nuevo en aproximadamente ${formatCooldown(cooldownRemaining)}.`;
  }
}

function checkAgentHealth() {
  if (!agentApiConfigured) {
    agentHealthReady = false;
    agentApiNote.textContent =
      "La URL HTTPS del agente es un placeholder. Configúrala antes de habilitar pagos.";
    showStatus("API del agente pendiente de despliegue", "warning");
    updateWalletUi();
    return Promise.resolve(false);
  }
  if (agentHealthCheckPromise) return agentHealthCheckPromise;

  agentHealthCheckInProgress = true;
  updateWalletUi();
  agentHealthCheckPromise = (async () => {
    try {
      const response = await fetch(`${AGENT_API_URL}/health`, {
        mode: "cors",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`El servicio respondió HTTP ${response.status}`);
      }
      const health = await response.json();
      if (health.ok !== true || health.network !== NETWORK_ID) {
        throw new Error("El servicio no confirmó que está disponible en NEAR testnet");
      }
      agentHealthReady = true;
      agentApiNote.textContent = "API HTTPS del agente disponible · NEAR testnet.";
      if (walletReady && !isSubmitting) {
        showStatus(
          walletSelector.isSignedIn()
            ? "Meteor Wallet conectada · testnet"
            : "Conecta Meteor Wallet · testnet",
        );
      }
      return true;
    } catch (error) {
      agentHealthReady = false;
      agentApiNote.textContent =
        `API HTTPS del agente no disponible: ${error.message}. El pago permanece deshabilitado.`;
      showStatus("API del agente no disponible", "warning");
      return false;
    } finally {
      agentHealthCheckInProgress = false;
      agentHealthCheckPromise = undefined;
      updateWalletUi();
    }
  })();
  return agentHealthCheckPromise;
}

async function initializeWallet() {
  const [core, meteor] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@near-wallet-selector/core@10.1.4/+esm"),
    import("https://cdn.jsdelivr.net/npm/@near-wallet-selector/meteor-wallet@10.1.4/+esm"),
  ]);
  actionCreators = core.actionCreators;
  setupWalletSelector = core.setupWalletSelector;
  setupMeteorWallet = meteor.setupMeteorWallet;
  if (
    typeof setupWalletSelector !== "function" ||
    typeof setupMeteorWallet !== "function" ||
    !actionCreators?.functionCall
  ) {
    throw new Error("El CDN cargó módulos incompatibles: faltan exports de Wallet Selector 10.1.4.");
  }
  walletSelector = await setupWalletSelector({
    network: {
      networkId: NETWORK_ID,
      nodeUrl: RPC_URL,
      helperUrl: "https://helper.testnet.near.org",
      explorerUrl: "https://explorer.testnet.near.org",
      indexerUrl: "https://test.api.fastnear.com/v0",
    },
    modules: [setupMeteorWallet()],
  });
  const meteorModule = walletSelector.store
    .getState()
    .modules.find((module) => module.id === "meteor-wallet");
  if (!meteorModule) {
    throw new Error("Wallet Selector inició, pero no registró el módulo Meteor Wallet.");
  }
  if (!meteorModule.metadata.available) {
    throw new Error("El módulo Meteor Wallet está registrado, pero no está disponible en este navegador.");
  }
  meteorWallet = await meteorModule.wallet();
  if (!meteorWallet) {
    throw new Error("Wallet Selector no pudo crear la instancia de Meteor Wallet.");
  }
  walletReady = true;
  walletSelector.on("signedIn", updateWalletUi);
  walletSelector.on("signedOut", updateWalletUi);
  walletSelector.on("accountsChanged", updateWalletUi);
  updateWalletUi();
}

function startMeteorWalletAction(action) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return action();
  } finally {
    console.log = originalLog;
  }
}

function handleWalletError(error) {
  showStatus("No se pudo conectar Meteor Wallet", "warning");
  showMessage(`No se pudo conectar Meteor Wallet: ${error.message}`);
}

function connectWallet() {
  if (!walletReady || !walletSelector || !meteorWallet) {
    showStatus("Meteor Wallet no está lista", "warning");
    showMessage(
      "No se puede abrir Meteor Wallet porque su inicialización no terminó. Revisa el error mostrado y recarga la página después de verificar conexión y extensiones.",
    );
    return;
  }
  if (walletSelector.isSignedIn()) {
    showStatus("Desconectando Meteor Wallet", "pending");
    meteorWallet.signOut()
      .then(() => {
        updateWalletUi();
        showStatus("Meteor Wallet desconectada · testnet");
      })
      .catch(handleWalletError);
    return;
  }
  showStatus("Abriendo Meteor Wallet · testnet", "pending");
  startMeteorWalletAction(() =>
    meteorWallet.signIn({
      contractId: CONTRACT_ID,
      methodNames: ["request_service"],
    }),
  )
    .then(() => {
      updateWalletUi();
      showStatus("Meteor Wallet conectada · testnet", "success");
    })
    .catch(handleWalletError);
}

function getTransactionHash(outcome) {
  return (
    outcome?.transaction?.hash ||
    outcome?.transaction_outcome?.id ||
    outcome?.transactionOutcome?.id ||
    ""
  );
}

function pause(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollAgentResult(requestId) {
  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
    await pause(RESULT_POLL_INTERVAL_MS);
    let response;
    try {
      response = await fetch(
        `${AGENT_API_URL}/api/requests/${encodeURIComponent(requestId)}`,
        { mode: "cors", signal: AbortSignal.timeout(5000) },
      );
    } catch {
      return {
        status: "unreachable",
        message:
          "No se pudo consultar la API HTTPS del agente. El pago permanece en testnet; conserva el request ID y no vuelvas a pagar.",
      };
    }
    if (response.status === 404) continue;
    if (!response.ok) {
      return {
        status: "failed",
        message: `La API del agente respondió HTTP ${response.status}. Conserva el request ID y no vuelvas a pagar.`,
      };
    }
    const result = await response.json();
    if (result.status === "completed") {
      return {
        status: "completed",
        message: result.report || result.message || "El agente registró el recibo.",
      };
    }
    if (result.status === "under_review") {
      return { status: "under_review", message: result.message };
    }
    if (result.status === "failed") {
      return { status: "failed", message: result.message };
    }
    showStatus(
      result.status === "queued" ? "Consulta en cola del agente…" : "Procesando consulta…",
      "pending",
    );
  }
  return {
    status: "pending",
    message:
      "El agente todavía procesa la solicitud. Conserva el request ID y el hash; no vuelvas a pagar esta consulta.",
  };
}

async function submitQuery() {
  if (isSubmitting || agentHealthCheckInProgress) return;
  if (!agentApiConfigured) {
    showStatus("API del agente no configurada", "warning");
    showMessage(
      "El endpoint HTTPS del agente aún no está configurado. No se puede iniciar un pago hasta desplegar y configurar el agente.",
    );
    return;
  }
  if (!walletSelector?.isSignedIn()) {
    showMessage("Conecta primero Meteor Wallet en NEAR testnet.");
    return;
  }
  const accountId = walletSelector.store.getState().accounts[0]?.accountId;
  if (!accountId) {
    showStatus("No se pudo identificar la cuenta conectada", "warning");
    showMessage("Desconecta y vuelve a conectar Meteor Wallet antes de enviar una solicitud.");
    return;
  }
  const cooldownRemaining = getRequestCooldownUntil(accountId) - Date.now();
  if (cooldownRemaining > 0) {
    showStatus("Límite de solicitudes activo", "warning");
    showMessage(
      `El contrato permite una solicitud por cuenta cada hora. Espera aproximadamente ${formatCooldown(cooldownRemaining)} antes de volver a pagar.`,
    );
    updateWalletUi();
    return;
  }
  const query = queryInput.value.trim();
  if (!query || [...query].length > 500) {
    showMessage("Escribe una consulta de entre 1 y 500 caracteres.");
    queryInput.focus();
    return;
  }
  if (!(await checkAgentHealth())) {
    showMessage(
      "La API HTTPS del agente no respondió correctamente en /health. No se envió ningún pago; inténtalo de nuevo cuando el agente esté disponible.",
    );
    return;
  }

  const requestId = window.crypto.randomUUID().toLowerCase();
  addHistoryEntry({
    requestId,
    wallet: accountId,
    query,
    status: "pending",
    transactionHash: "",
    date: new Date().toISOString(),
  });
  isSubmitting = true;
  updateWalletUi();
  submitButton.querySelector("span").textContent = "Esperando aprobación…";
  showStatus("Confirma el pago en tu wallet", "pending");
  showMessage("La wallet abrirá una transacción de 0.1 NEAR exactos en NEAR testnet.", requestId);

  let transactionHash = "";
  try {
    const outcome = await meteorWallet.signAndSendTransaction({
      receiverId: CONTRACT_ID,
      actions: [
        actionCreators.functionCall(
          "request_service",
          { request_id: requestId, query },
          BigInt(REQUEST_GAS),
          BigInt(FEE_YOCTO),
        ),
      ],
    });
    recordRequestCooldown(accountId);
    transactionHash = getTransactionHash(outcome);
    updateHistoryEntry(accountId, requestId, { transactionHash });
    updateWalletUi();
    showStatus("Pago confirmado · esperando agente", "success");
    showMessage(
      "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
      requestId,
      transactionHash,
    );

    const result = await pollAgentResult(requestId);
    const historyStatus =
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "under_review"
        ? result.status
        : "pending";
    updateHistoryEntry(accountId, requestId, {
      status: historyStatus,
      transactionHash,
    });
    showStatus(
      result.status === "completed"
        ? "Respuesta recibida"
        : result.status === "under_review"
          ? "En revisión humana"
          : result.status === "pending"
            ? "Agente procesando"
            : "Revisar agente",
      result.status === "completed" ? "success" : result.status === "pending" ? "pending" : "warning",
    );
    showMessage(result.message, requestId, transactionHash);
  } catch (error) {
    if (transactionHash) {
      updateHistoryEntry(accountId, requestId, {
        status: "pending",
        transactionHash,
      });
      showStatus("Transacción enviada · resultado incierto", "warning");
      showMessage(
        `No se pudo confirmar la respuesta desde el navegador (${error.message}). Comprueba la transacción en el explorador antes de repetir; no vuelvas a pagar a ciegas.`,
        requestId,
        transactionHash,
      );
    } else {
      updateHistoryEntry(accountId, requestId, { status: "failed" });
      showStatus("Pago cancelado o fallido", "warning");
      const errorMessage = error.message || String(error);
      const contractTrap = /WebAssembly trap|unreachable opcode/i.test(errorMessage);
      showMessage(
        contractTrap
          ? `El contrato rechazó la llamada. Cada intento usa un request_id nuevo, pero OrbitHire acepta una solicitud por cuenta cada hora. Si esta cuenta ya tuvo una solicitud exitosa en la última hora, espera a que venza ese límite. ${errorMessage}`
          : `La wallet no confirmó el pago. Si no aprobaste la transacción, no se envió ninguna consulta. ${errorMessage}`,
        requestId,
      );
    }
  } finally {
    isSubmitting = false;
    submitButton.querySelector("span").textContent = "Pagar y consultar";
    updateWalletUi();
  }
}

queryInput.addEventListener("input", () => {
  charCount.textContent = `${[...queryInput.value].length} / 500`;
});
walletButton.addEventListener("click", connectWallet);
submitButton.addEventListener("click", () => {
  submitQuery().catch((error) => {
    showStatus("Error", "warning");
    showMessage(`No se pudo completar la solicitud: ${error.message}`);
  });
});
window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(REQUEST_COOLDOWN_STORAGE_PREFIX)) {
    updateWalletUi();
  }
  if (event.key?.startsWith(REQUEST_HISTORY_STORAGE_PREFIX)) {
    const accountId = walletSelector?.isSignedIn()
      ? walletSelector.store.getState().accounts[0]?.accountId
      : "";
    if (accountId && event.key === `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`) {
      requestHistoryCache.delete(accountId);
      renderHistory(accountId);
    }
  }
});

showStatus("Conectando con NEAR testnet", "pending");
initializeWallet()
  .then(() => {
    if (agentHealthReady) {
      showStatus(
        walletSelector.isSignedIn()
          ? "Meteor Wallet conectada · testnet"
          : "Conecta Meteor Wallet · testnet",
      );
    }
  })
  .catch((error) => {
    walletReady = false;
    walletButton.disabled = true;
    showStatus("No se pudo inicializar Meteor Wallet", "warning");
    showMessage(
      `No se pudo inicializar Meteor Wallet en NEAR ${NETWORK_ID}: ${error.message}. Comprueba que jsDelivr sea accesible y que la extensión esté habilitada; luego recarga la página.`,
    );
  });

void checkAgentHealth();
window.setInterval(() => {
  void checkAgentHealth();
}, AGENT_HEALTH_POLL_INTERVAL_MS);
