const CONTRACT_ID = "orbit-hire.shortemail369.testnet";
const NETWORK_ID = "testnet";
const RPC_URL = "https://rpc.testnet.near.org";
// TODO: Replace with the deployed HTTPS agent API origin.
const AGENT_API_URL = "https://agent-api.example.com";
const FEE_YOCTO = "100000000000000000000000";
const REQUEST_GAS = "100000000000000";
const EXPLORER_URL = "https://explorer.testnet.near.org/transactions/";
const RESULT_POLL_INTERVAL_MS = 2500;
const RESULT_POLL_ATTEMPTS = 48;

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

let walletSelector;
let meteorWallet;
let walletReady = false;
let actionCreators;
let setupWalletSelector;
let setupMeteorWallet;
let isSubmitting = false;
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

function updateWalletUi() {
  const signedIn = Boolean(walletSelector?.isSignedIn());
  walletButton.disabled = !walletReady;
  submitButton.disabled = !signedIn || !agentApiConfigured || isSubmitting;
  if (signedIn) {
    const accountId = walletSelector.store.getState().accounts[0]?.accountId || "Wallet conectada";
    walletButton.textContent = `${accountId.slice(0, 11)}… · Salir`;
  } else {
    walletButton.textContent = "Conectar Meteor Wallet";
  }
}

async function initializeWallet() {
  const [core, meteor] = await Promise.all([
    import("https://esm.sh/@near-wallet-selector/core@10.1.4?bundle&target=es2022"),
    import("https://esm.sh/@near-wallet-selector/meteor-wallet@10.1.4?bundle&target=es2022"),
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
  if (isSubmitting) return;
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
  const query = queryInput.value.trim();
  if (!query || [...query].length > 500) {
    showMessage("Escribe una consulta de entre 1 y 500 caracteres.");
    queryInput.focus();
    return;
  }

  const requestId = window.crypto.randomUUID().toLowerCase();
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
    transactionHash = getTransactionHash(outcome);
    showStatus("Pago confirmado · esperando agente", "success");
    showMessage(
      "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
      requestId,
      transactionHash,
    );

    const result = await pollAgentResult(requestId);
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
      showStatus("Transacción enviada · resultado incierto", "warning");
      showMessage(
        `No se pudo confirmar la respuesta desde el navegador (${error.message}). Comprueba la transacción en el explorador antes de repetir; no vuelvas a pagar a ciegas.`,
        requestId,
        transactionHash,
      );
    } else {
      showStatus("Pago cancelado o fallido", "warning");
      showMessage(
        `La wallet no confirmó el pago. Si no aprobaste la transacción, no se envió ninguna consulta. ${error.message}`,
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

showStatus("Conectando con NEAR testnet", "pending");
initializeWallet()
  .then(() =>
    showStatus(
      walletSelector.isSignedIn() ? "Meteor Wallet conectada · testnet" : "Conecta Meteor Wallet · testnet",
    ),
  )
  .catch((error) => {
    walletReady = false;
    walletButton.disabled = true;
    showStatus("No se pudo inicializar Meteor Wallet", "warning");
    showMessage(
      `No se pudo inicializar Meteor Wallet en NEAR ${NETWORK_ID}: ${error.message}. Comprueba que el CDN esm.sh sea accesible y que la extensión esté habilitada; luego recarga la página.`,
    );
  });

if (!agentApiConfigured) {
  showStatus("API del agente pendiente de despliegue", "warning");
  submitButton.disabled = true;
} else {
  agentApiNote.textContent = "La solicitud se procesará en el agente hospedado tras confirmarse en testnet.";
}
