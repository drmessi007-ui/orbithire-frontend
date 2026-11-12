# OrbitHire static frontend

Static HTML, CSS, and JavaScript for GitHub Pages. No bundler or build step is required. The page uses NEAR Wallet Selector 10.1.4 and its Meteor Wallet module from the pinned esm.sh CDN and connects to **NEAR testnet only**. Meteor Wallet is the only supported wallet in this frontend; sign-in is initiated directly from the connection button. Install Meteor Wallet from [wallet.meteorwallet.app](https://wallet.meteorwallet.app/).

The current NEAR documentation marks Wallet Selector as deprecated. This integration uses it to support Meteor Wallet as requested; consider migrating to NEAR Connect if the wallet integration is expanded.

## GitHub Pages

1. Push the repository to GitHub without the ignored `secrets/` directory or any `.env` file.
2. In the repository settings, enable GitHub Pages for the branch and `/frontend` folder (or publish the `frontend` folder with your Pages workflow).
3. Open the published HTTPS page, connect Meteor Wallet on testnet, enter the query and the local agent token, then select **Pagar y consultar**.

The app pays exactly `0.1 NEAR` to `orbit-hire.shortemail369.testnet` by calling `request_service`. It displays the transaction in NEAR Testnet Explorer. The Treasury contract is listed for transparency; the OrbitHire contract coordinates its escrow calls.

## Local agent requirements

The agent must already be running on the same computer at `http://localhost:8787`, with `secrets/.env` loaded and its `LOCAL_AGENT_TOKEN` configured. Expand **Conexión con el agente local** in the page and enter that token. The frontend keeps the value in memory/input only, does not persist it, and sends it only in a Bearer authorization header to localhost. The local agent supports CORS from `*.github.io` origins for this browser flow.

The page posts the exact query and on-chain request ID to `/requests`, then polls `/requests/{request_id}` for the response. A transaction can succeed even if the agent is unavailable or the token is wrong. In that case the page shows the request ID and transaction hash: start/fix the agent and use **Reintentar envío al agente** to resend the same request ID and exact query without submitting another payment. The page must remain open because it does not persist the query or token across reloads. **Do not pay again for the same request.** Refunds depend on the contract's timeout/review state and are not automatic.

The query is part of the public NEAR transaction arguments. Do not enter secrets, personal data, or sensitive information. This is a beta connected to testnet, not mainnet, and testnet behavior or availability may change.

## Contracts and fee

- OrbitHire: `orbit-hire.shortemail369.testnet`
- OrbitTreasury: `orbit-treasury.shortemail369.testnet`
- Network: NEAR testnet (`https://rpc.testnet.near.org`)
- Fixed fee: `100000000000000000000000` yoctoNEAR (`0.1 NEAR`)

No signing keys, Jev API keys, or local agent tokens are embedded in the static frontend. Meteor Wallet signs the payment transaction through NEAR Wallet Selector. The app configures Wallet Selector with the NEAR testnet RPC and requests access only to `request_service` on the OrbitHire contract.
