import 'dotenv/config';
import { ethers } from 'ethers';

const CONTRACT_ADDRESS = '0x460d7dfa7aefb52ddb7b87a767485325b31272d9';
const CHAIN_ID = 1n;
const ZERO_VALUE = 0n;

const MINT_NAME_HINTS = [
  'mint',
  'publicmint',
  'freemint',
  'safemint',
  'claim',
  'publicsale',
  'presale',
];

const REVERT_HINTS = {
  soldOut: ['sold out', 'soldout', 'sold', 'exceed supply', 'exceeds supply', 'max supply', 'supply exceeded'],
  ended: ['ended', 'closed', 'inactive', 'not active', 'sale is not active', 'sale closed', 'mint closed', 'free mint ended'],
  insufficientFunds: ['insufficient funds', 'insufficient balance', 'not enough funds'],
  nonceTooLow: ['nonce too low', 'replacement transaction underpriced', 'already known'],
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function normalizeAddress(address) {
  return ethers.getAddress(address);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'mint-bot/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function readAbiFromSourcify(address) {
  const checksumAddress = normalizeAddress(address);
  const urls = [
    `https://repo.sourcify.dev/contracts/full_match/1/${checksumAddress}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/1/${checksumAddress}/metadata.json`,
  ];

  for (const url of urls) {
    try {
      const metadata = await fetchJson(url);
      const abi = metadata?.output?.abi;
      if (Array.isArray(abi) && abi.length > 0) {
        console.log(`ABI loaded from Sourcify: ${url}`);
        return abi;
      }
    } catch (error) {
      console.warn(`Sourcify ABI lookup failed for ${url}: ${error.message}`);
    }
  }

  return null;
}

async function readAbiFromEtherscan(address) {
  const query = new URLSearchParams({ module: 'contract', action: 'getabi', address });
  if (process.env.ETHERSCAN_API_KEY?.trim()) {
    query.set('apikey', process.env.ETHERSCAN_API_KEY.trim());
  }
  const url = `https://api.etherscan.io/api?${query.toString()}`;

  try {
    const result = await fetchJson(url);
    if (result?.status === '1' && result?.result) {
      console.log('ABI loaded from Etherscan.');
      return JSON.parse(result.result);
    }

    throw new Error(result?.result || result?.message || 'unknown Etherscan response');
  } catch (error) {
    console.warn(`Etherscan ABI lookup failed: ${error.message}`);
    return null;
  }
}

async function readAbi(address) {
  const abi = (await readAbiFromSourcify(address)) || (await readAbiFromEtherscan(address));
  if (!abi) {
    throw new Error('Unable to read ABI automatically. Verify that the contract is verified on Sourcify or Etherscan.');
  }
  return abi;
}

function isWritableFunction(fragment) {
  return fragment.type === 'function' && fragment.stateMutability !== 'view' && fragment.stateMutability !== 'pure';
}

function scoreMintFunction(fragment) {
  const name = fragment.name.toLowerCase();
  let score = 0;

  for (const hint of MINT_NAME_HINTS) {
    if (name === hint) score += 100;
    else if (name.includes(hint)) score += 50;
  }

  if (fragment.inputs.length === 0) score += 40;
  if (fragment.inputs.length === 1) score += 25;
  if (fragment.inputs.length === 2) score += 10;
  if (fragment.stateMutability === 'payable') score += 5;

  return score;
}

function identifyMintFunction(contractInterface) {
  const candidates = contractInterface.fragments
    .filter(isWritableFunction)
    .map((fragment) => ({ fragment, score: scoreMintFunction(fragment) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.fragment.inputs.length - b.fragment.inputs.length);

  if (candidates.length === 0) {
    throw new Error('No likely mint function was found in the ABI.');
  }

  const selected = candidates[0].fragment;
  console.log(`Selected mint function: ${selected.format('full')}`);
  return selected;
}

function autoValue(fragment) {
  if (fragment.stateMutability !== 'payable') {
    return ZERO_VALUE;
  }

  if (process.env.MINT_VALUE_ETH && process.env.MINT_VALUE_ETH.trim() !== '') {
    return ethers.parseEther(process.env.MINT_VALUE_ETH.trim());
  }

  return ZERO_VALUE;
}

function buildArgForInput(input, walletAddress) {
  const type = input.type.toLowerCase();
  const name = (input.name || '').toLowerCase();

  if (type === 'address') {
    return walletAddress;
  }

  if (type === 'bool') {
    return true;
  }

  if (type.startsWith('uint') || type.startsWith('int')) {
    if (name.includes('tokenid') || name === 'id') {
      throw new Error(`Cannot safely infer token id for argument "${input.name || input.type}".`);
    }
    return 1n;
  }

  if (type === 'bytes32[]' || type === 'bytes[]') {
    if (name.includes('proof') || name.includes('merkle')) {
      return [];
    }
  }

  if (type === 'bytes32') {
    if (name.includes('root')) {
      throw new Error(`Cannot infer merkle root for argument "${input.name || input.type}".`);
    }
    return ethers.ZeroHash;
  }

  if (type === 'bytes') {
    return '0x';
  }

  if (type === 'string') {
    return '';
  }

  if (type.endsWith('[]')) {
    return [];
  }

  throw new Error(`Cannot infer value for argument "${input.name || '<unnamed>'}" of type "${input.type}".`);
}

function buildMintArguments(fragment, walletAddress) {
  return fragment.inputs.map((input) => buildArgForInput(input, walletAddress));
}

function extractErrorMessage(error) {
  return String(
    error?.shortMessage ||
      error?.reason ||
      error?.info?.error?.message ||
      error?.error?.message ||
      error?.message ||
      error,
  );
}

function classifyError(error) {
  const message = extractErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes('execution reverted') || lower.includes('reverted')) {
    if (REVERT_HINTS.soldOut.some((hint) => lower.includes(hint))) {
      return `execution reverted: sold out / supply limit reached (${message})`;
    }
    if (REVERT_HINTS.ended.some((hint) => lower.includes(hint))) {
      return `execution reverted: free mint or sale appears ended/closed (${message})`;
    }
    if (REVERT_HINTS.insufficientFunds.some((hint) => lower.includes(hint))) {
      return `execution reverted: insufficient funds or payment (${message})`;
    }
    return `execution reverted: ${message}`;
  }

  if (REVERT_HINTS.soldOut.some((hint) => lower.includes(hint))) {
    return `sold out / supply limit reached: ${message}`;
  }

  if (REVERT_HINTS.insufficientFunds.some((hint) => lower.includes(hint))) {
    return `insufficient funds: ${message}`;
  }

  if (REVERT_HINTS.nonceTooLow.some((hint) => lower.includes(hint))) {
    return `nonce too low or pending nonce conflict: ${message}`;
  }

  return message;
}

async function printGas(provider) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  console.log(`gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  if (feeData.maxFeePerGas) {
    console.log(`max fee per gas: ${ethers.formatUnits(feeData.maxFeePerGas, 'gwei')} gwei`);
  }
  if (feeData.maxPriorityFeePerGas) {
    console.log(`max priority fee per gas: ${ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} gwei`);
  }
  return feeData;
}

async function main() {
  const privateKey = requireEnv('PRIVATE_KEY');
  const rpcUrl = requireEnv('RPC_URL');

  if (!rpcUrl.startsWith('ws://') && !rpcUrl.startsWith('wss://')) {
    throw new Error('RPC_URL must be a WebSocket endpoint starting with ws:// or wss://.');
  }

  const provider = new ethers.WebSocketProvider(rpcUrl, 'mainnet');
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Connected to chain ${network.chainId}; expected Ethereum mainnet chain ${CHAIN_ID}.`);
  }

  const baseWallet = new ethers.Wallet(privateKey, provider);
  const signer = new ethers.NonceManager(baseWallet);
  const walletAddress = await signer.getAddress();

  console.log(`Connected to Ethereum Mainnet (chainId ${network.chainId}).`);
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Contract: ${CONTRACT_ADDRESS}`);

  const abi = await readAbi(CONTRACT_ADDRESS);
  const contractInterface = new ethers.Interface(abi);
  const mintFragment = identifyMintFunction(contractInterface);
  const mintArgs = buildMintArguments(mintFragment, walletAddress);
  const mintValue = autoValue(mintFragment);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, signer);
  const mintMethod = contract.getFunction(mintFragment.format('sighash'));
  const attemptedBlocks = new Set();

  console.log(`Auto-filled mint args: ${JSON.stringify(mintArgs, (_, value) => (typeof value === 'bigint' ? value.toString() : value))}`);
  console.log(`Mint value: ${ethers.formatEther(mintValue)} ETH`);
  console.log('Listening for new blocks...');

  provider.on('block', async (blockNumber) => {
    if (attemptedBlocks.has(blockNumber)) {
      return;
    }
    attemptedBlocks.add(blockNumber);

    console.log('\n----------------------------------------');
    console.log(`current block: ${blockNumber}`);

    try {
      const feeData = await printGas(provider);
      const txRequest = {
        value: mintValue,
      };

      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        txRequest.maxFeePerGas = feeData.maxFeePerGas;
        txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else if (feeData.gasPrice) {
        txRequest.gasPrice = feeData.gasPrice;
      }

      await mintMethod.staticCall(...mintArgs, txRequest);
      const estimatedGas = await mintMethod.estimateGas(...mintArgs, txRequest);
      txRequest.gasLimit = (estimatedGas * 120n) / 100n;

      console.log(`estimated gas: ${estimatedGas.toString()}`);
      const tx = await mintMethod(...mintArgs, txRequest);
      console.log('mint submitted: success');
      console.log(`tx hash: ${tx.hash}`);

      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        console.log(`mint confirmed: success in block ${receipt.blockNumber}`);
      } else {
        console.log(`mint confirmed: failed; tx hash: ${tx.hash}`);
      }
    } catch (error) {
      console.log('mint submitted: failed');
      console.log(`reason: ${classifyError(error)}`);
      if (error?.transaction?.hash) {
        console.log(`tx hash: ${error.transaction.hash}`);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nStopping block listener...');
    provider.removeAllListeners('block');
    await provider.destroy();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`Fatal error: ${classifyError(error)}`);
  process.exit(1);
});
