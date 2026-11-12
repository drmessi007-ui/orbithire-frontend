const CONTRACT_ID = "orbit-hire.shortemail369.testnet";
const TREASURY_ID = "orbit-treasury.shortemail369.testnet";
const NETWORK_ID = "testnet";
const RPC_URL = "https://rpc.testnet.near.org";
const WALLET_URL = "https://testnet.mynearwallet.com";
const LOCAL_AGENT_URL = "http://localhost:8787";
const FEE_YOCTO = "100000000000000000000000";
const REQUEST_GAS = "100000000000000";
const EXPLORER_URL = "https://explorer.testnet.near.org/transactions/";
const RESULT_POLL_INTERVAL_MS = 2500;
const RESULT_POLL_ATTEMPTS = 48;

const walletButton = document.querySelector("#wallet-button");
const submitButton = document.querySelector("#submit-button");
const queryInput = document.querySelector("#query");
const tokenInput = document.querySelector("#agent-token");
const charCount = document.querySelector("#char-count");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const resultContent = document.querySelector("#result-content");
const resultCopy = document.querySelector("#result-copy");
const requestIdLabel = document.querySelector("#request-id");
const transactionLink = document.querySelector("#transaction-link");
const retryButton = document.querySelector("#retry-button");

let near;
let walletConnection;
let walletAccount;
let isSubmitting = false;
let lastPaidRequest = null;

function showStatus(message, state = "idle") {
  statusLabel.textContent = message;
  statusLabel.dataset.state = state;
}

function showMessage(message, requestId = "", transactionHash = "", canRetry = false) {
  emptyState.hidden = true;
  resultContent.hidden = false;
  resultCopy.textContent = message;
  requestIdLabel.textContent = requestId || "—";
  retryButton.hidden = !canRetry;
  if (transactionHash) {
    transactionLink.href = `${EXPLORER_URL}${encodeURIComponent(transactionHash)}`;
    transactionLink.hidden = false;
  } else {
    transactionLink.removeAttribute("href");
    transactionLink.hidden = true;
  }
}

function resetResult() {
  resultContent.hidden = true;
  emptyState.hidden = false;
  retryButton.hidden = true;
  showStatus("A la espera de una consulta");
}

function updateWalletUi() {
  const signedIn = Boolean(walletConnection?.isSignedIn());
  if (signedIn) {
    const accountId = walletConnection.getAccountId();
    walletButton.textContent = `${accountId.slice(0, 11)}… · Salir`;
    submitButton.disabled = false;
  } else {
    walletButton.textContent = "Conectar wallet";
    submitButton.disabled = true;
  }
}

async function initializeWallet() {
  if (!window.nearApi) {
    throw new Error("No se pudo cargar near-api-js desde el CDN. Revisa tu conexión y recarga.");
  }
  near = await window.nearApi.connect({
    networkId: NETWORK_ID,
    nodeUrl: RPC_URL,
    walletUrl: WALLET_URL,
    helperUrl: "https://helper.testnet.near.org",
    explorerUrl: "https://explorer.testnet.near.org",
    keyStore: new window.nearApi.keyStores.BrowserLocalStorageKeyStore(),
  });
  walletConnection = new window.nearApi.WalletConnection(near, "orbithire-static");
  walletAccount = walletConnection.account();
  updateWalletUi();
}

async function connectWallet() {
  if (!walletConnection) {
    showMessage("La conexión con NEAR todavía se está inicializando.");
    return;
  }
  if (walletConnection.isSignedIn()) {
    walletConnection.signOut();
    window.location.reload();
    return;
  }
  await walletConnection.requestSignIn({
    contractId: CONTRACT_ID,
    methodNames: ["request_service"],
    successUrl: window.location.href,
  });
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

async function sendQueryToAgent(requestId, query, token) {
  if (!token) {
    return {
      ok: false,
      message: "Pago confirmado, pero falta LOCAL_AGENT_TOKEN. Abre «Conexión con el agente local» para enviarlo.",
    };
  }
  let response;
  try {
    response = await fetch(`${LOCAL_AGENT_URL}/requests`, {
      method: "POST",
      mode: "cors",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ request_id: requestId, query }),
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    return {
      ok: false,
      message:
        "El pago quedó registrado en testnet, pero no se pudo contactar al agente en localhost:8787. Inicia el agente local y vuelve a enviar el mismo request ID y query desde esta página; no vuelvas a pagar.",
    };
  }
  if (!response.ok) {
    if (response.status === 401) {
      return {
        ok: false,
        message:
          "El pago quedó registrado, pero el token local fue rechazado. Corrige LOCAL_AGENT_TOKEN y reenvía el mismo request ID y query; no vuelvas a pagar.",
      };
    }
    if (response.status === 409) {
      return { ok: true, message: "El agente ya recibió esta consulta; comprobando su resultado." };
    }
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      message: `El pago quedó registrado, pero el agente respondió HTTP ${response.status}${body ? `: ${body}` : ""}.`,
    };
  }
  return { ok: true, message: "El agente recibió la consulta. Esperando el resultado…" };
}

async function pollAgentResult(requestId, token) {
  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
    await pause(RESULT_POLL_INTERVAL_MS);
    let response;
    try {
      response = await fetch(
        `${LOCAL_AGENT_URL}/requests/${encodeURIComponent(requestId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          mode: "cors",
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      return {
        status: "unreachable",
        message:
          "Se perdió la conexión con el agente local. El pago permanece en testnet; revisa el estado con el request ID y no vuelvas a pagar.",
      };
    }
    if (response.status === 404) continue;
    if (response.status === 401) {
      return { status: "failed", message: "El token local expiró o no es válido." };
    }
    if (!response.ok) continue;
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
    if (result.status === "processing") {
      showStatus("Procesando consulta…", "pending");
    }
  }
  return {
    status: "pending",
    message:
      "El agente todavía no ha publicado un resultado. Conserva el request ID y verifica el agente local; no vuelvas a pagar esta consulta.",
  };
}

async function submitQuery() {
  if (isSubmitting) return;
  if (!walletConnection?.isSignedIn()) {
    showMessage("Conecta primero tu wallet NEAR testnet.");
    return;
  }
  const query = queryInput.value.trim();
  if (!query || [...query].length > 500) {
    showMessage("Escribe una consulta de entre 1 y 500 caracteres.");
    queryInput.focus();
    return;
  }

  const requestId = window.crypto.randomUUID().toLowerCase();
  const localToken = tokenInput.value.trim();
  lastPaidRequest = { requestId, query, transactionHash: "" };
  isSubmitting = true;
  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Esperando aprobación…";
  showStatus("Confirma el pago en tu wallet", "pending");
  showMessage("La wallet abrirá una transacción de 0.1 NEAR exactos en NEAR testnet.", requestId);

  let transactionHash = "";
  try {
    const outcome = await walletAccount.functionCall({
      contractId: CONTRACT_ID,
      methodName: "request_service",
      args: { request_id: requestId, query },
      gas: REQUEST_GAS,
      attachedDeposit: FEE_YOCTO,
    });
    transactionHash = getTransactionHash(outcome);
    lastPaidRequest.transactionHash = transactionHash;
    showStatus("Pago confirmado · contactando agente", "success");
    showMessage(
      "Pago confirmado en NEAR testnet. Intentando entregar la consulta al agente local…",
      requestId,
      transactionHash,
    );

    const delivery = await sendQueryToAgent(requestId, query, localToken);
    if (!delivery.ok) {
      showStatus("Pago confirmado · agente no disponible", "warning");
      showMessage(delivery.message, requestId, transactionHash, true);
      return;
    }

    tokenInput.value = "";
    showStatus("Consulta en curso", "pending");
    showMessage(delivery.message, requestId, transactionHash);
    const result = await pollAgentResult(requestId, localToken);
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
    showMessage(
      result.message,
      requestId,
      transactionHash,
      result.status === "pending" || result.status === "unreachable",
    );
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

async function retryAgentDelivery() {
  if (!lastPaidRequest || isSubmitting) return;
  const token = tokenInput.value.trim();
  if (!token) {
    showStatus("Falta token del agente", "warning");
    showMessage(
      "Pega LOCAL_AGENT_TOKEN en «Conexión con el agente local» para reenviar sin cobrar otra vez.",
      lastPaidRequest.requestId,
      lastPaidRequest.transactionHash,
      true,
    );
    tokenInput.focus();
    return;
  }
  isSubmitting = true;
  retryButton.disabled = true;
  showStatus("Reenviando al agente · sin pago", "pending");
  const { requestId, query, transactionHash } = lastPaidRequest;
  try {
    const delivery = await sendQueryToAgent(requestId, query, token);
    if (!delivery.ok) {
      showStatus("El agente aún no está disponible", "warning");
      showMessage(delivery.message, requestId, transactionHash, true);
      return;
    }
    tokenInput.value = "";
    showStatus("Consulta en curso", "pending");
    showMessage(delivery.message, requestId, transactionHash);
    const result = await pollAgentResult(requestId, token);
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
    showMessage(
      result.message,
      requestId,
      transactionHash,
      result.status === "pending" || result.status === "unreachable",
    );
  } catch (error) {
    showStatus("No se pudo reenviar", "warning");
    showMessage(`La entrega local falló: ${error.message}`, requestId, transactionHash, true);
  } finally {
    isSubmitting = false;
    retryButton.disabled = false;
    updateWalletUi();
  }
}

queryInput.addEventListener("input", () => {
  charCount.textContent = `${[...queryInput.value].length} / 500`;
});
walletButton.addEventListener("click", () => {
  connectWallet().catch((error) => showMessage(`No se pudo conectar la wallet: ${error.message}`));
});
submitButton.addEventListener("click", () => {
  submitQuery().catch((error) => {
    showStatus("Error", "warning");
    showMessage(`No se pudo completar la solicitud: ${error.message}`);
  });
});
retryButton.addEventListener("click", () => {
  retryAgentDelivery().catch((error) => {
    showStatus("No se pudo reenviar", "warning");
    showMessage(
      `La entrega local falló: ${error.message}`,
      lastPaidRequest?.requestId,
      lastPaidRequest?.transactionHash,
      true,
    );
  });
});

showStatus("Conectando con NEAR testnet", "pending");
initializeWallet()
  .then(() => showStatus(walletConnection.isSignedIn() ? "Wallet conectada · testnet" : "Conecta tu wallet · testnet"))
  .catch((error) => {
    showStatus("NEAR no disponible", "warning");
    showMessage(error.message);
  });
