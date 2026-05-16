# mint-bot

This repository contains two ethers.js v6 examples for the Ethereum mainnet NFT contract:

```text
0x460d7dfa7aefb52ddb7b87a767485325b31272d9
```

## Option A: Node.js private-key mint watcher

The original script runs in Node.js, connects to Ethereum mainnet over a WebSocket RPC, listens for new blocks, and attempts one mint transaction per block using the private key in `.env`.

### Install

```bash
npm install
```

### Configure

Copy the example environment file and fill in your own private key and Ethereum mainnet WebSocket RPC URL:

```bash
cp .env.example .env
```

```env
PRIVATE_KEY=0xyour_private_key_here
RPC_URL=wss://eth-mainnet.g.alchemy.com/v2/your_websocket_key
```

### Run

```bash
node index.js
```

The script prints the current block, gas price, mint simulation result, transaction hash, and success/failure reason.

## Option B: Browser wallet mint monitor

If you want to connect a browser wallet such as MetaMask or Rabby, run the browser UI instead:

```bash
npm run browser
```

Then open:

```text
http://localhost:5173
```

The browser page:

- connects to the injected wallet provider instead of reading `PRIVATE_KEY`;
- switches/checks Ethereum Mainnet;
- reads the contract ABI from Sourcify first, then optionally Etherscan;
- identifies the most likely mint function;
- prints current block, gas price, selected mint function, transaction hash, and mint result;
- can manually attempt mint once or enable automatic per-block attempts.

Important limitation: browser wallets intentionally do **not** allow a website to silently sign or auto-confirm transactions. The page can automatically prepare and request a transaction on each new block, but every transaction still requires manual approval in the wallet popup. This protects your wallet from websites draining funds without consent.
