import { BrowserProvider, Contract, Interface, formatUnits, parseEther, ZeroAddress } from 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm';

const MAINNET_CHAIN_ID = 1n;
const DEFAULT_CONTRACT_ADDRESS = '0x460d7dfa7aefb52ddb7b87a767485325b31272d9';
const MINT_NAME_HINTS = ['mint', 'publicmint', 'freemint', 'safemint', 'claim', 'publicsale', 'presale'];
const REVERT_HINTS = {
  soldOut: ['sold out', 'soldout', 'exceed supply', 'exceeds supply', 'max supply', 'supply exceeded'],
  ended: ['ended', 'closed', 'inactive', 'not active', 'sale is not active', 'sale closed', 'mint closed', 'free mint ended'],
  insufficientFunds: ['insufficient funds', 'insufficient balance', 'not enough funds'],
  nonceTooLow: ['nonce too low', 'replacement transaction underpriced', 'already known'],
  userRejected: ['user rejected', 'user denied', 'rejected the request', 'action_rejected'],
};

const elements = {
  contractAddress: document.querySelector('#contractAddress'),
  mintValueEth: document.querySelector('#mintValueEth'),
  etherscanApiKey: document.querySelector('#etherscanApiKey'),
  connectButton: document.querySelector('#connectButton'),
  loadAbiButton: document.querySelector('#loadAbiButton'),
  mintNowButton: document.querySelector('#mintNowButton'),
  autoButton: document.querySelector('#autoButton'),
  walletAddress: document.querySelector('#walletAddress'),
  networkName: document.querySelector('#networkName'),
  currentBlock: document.querySelector('#currentBlock'),
  gasPrice: document.querySelector('#gasPrice'),
  mintFunction: document.querySelector('#mintFunction'),
  lastTx: document.querySelector('#lastTx'),
  log: document.querySelector('#log'),
};

let provider;
let signer;
let walletAddress;
let contract;
let abi;
let mintFragment;
let autoEnabled = false;
let pendingWalletPrompt = false;
const attemptedBlocks = new Set();

function log(message, level = 'info') {
  const time = new Date().toISOString();
  const prefix = level.toUpperCase().padEnd(7, ' ');
  elements.log.textContent += `[${time}] ${prefix} ${message}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setButtons() {
  const hasWallet = Boolean(provider && signer);
  const hasMint = Boolean(contract && mintFragment);
  elements.loadAbiButton.disabled = !hasWallet;
  elements.mintNowButton.disabled = !hasMint || pendingWalletPrompt;
  elements.autoButton.disabled = !hasMint;
  elements.autoButton.textContent = autoEnabled ? '关闭自动每区块尝试' : '开启自动每区块尝试';
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function readAbiFromSourcify(address) {
  const urls = [
    `https://repo.sourcify.dev/contracts/full_match/1/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/1/${address}/metadata.json`,
  ];

  for (const url of urls) {
    try {
      const metadata = await fetchJson(url);
      const candidate = metadata?.output?.abi;
      if (Array.isArray(candidate) && candidate.length > 0) {
        log(`ABI loaded from Sourcify: ${url}`);
        return candidate;
      }
    } catch (error) {
      log(`Sourcify ABI lookup failed: ${error.message}`, 'warn');
    }
  }

  return null;
}

async function readAbiFromEtherscan(address) {
  const query = new URLSearchParams({ module: 'contract', action: 'getabi', address });
  const apiKey = elements.etherscanApiKey.value.trim();
  if (apiKey) query.set('apikey', apiKey);

  try {
    const result = await fetchJson(`https://api.etherscan.io/api?${query.toString()}`);
    if (result?.status === '1' && result?.result) {
      log('ABI loaded from Etherscan.');
      return JSON.parse(result.result);
    }
    throw new Error(result?.result || result?.message || 'unknown Etherscan response');
  } catch (error) {
    log(`Etherscan ABI lookup failed: ${error.message}`, 'warn');
    return null;
  }
}

async function readAbi(address) {
  const loadedAbi = (await readAbiFromSourcify(address)) || (await readAbiFromEtherscan(address));
  if (!loadedAbi) {
    throw new Error('Unable to read ABI automatically. Verify that the contract is verified on Sourcify or Etherscan.');
  }
  return loadedAbi;
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

function identifyMintFunction(loadedAbi) {
  const iface = new Interface(loadedAbi);
  const candidates = iface.fragments
    .filter(isWritableFunction)
    .map((fragment) => ({ fragment, score: scoreMintFunction(fragment) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    throw new Error('No likely mint function found in ABI.');
  }

  return candidates[0].fragment;
}

function inferArgument(input) {
  const name = input.name.toLowerCase();
  const type = input.type.toLowerCase();

  if (type === 'address') {
    if (name.includes('zero') || name.includes('delegate')) return ZeroAddress;
    return walletAddress;
  }

  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'bytes') return '0x';
  if (type.endsWith('[]')) return [];
  if (type.startsWith('uint') || type.startsWith('int')) {
    if (name.includes('quantity') || name.includes('qty') || name.includes('amount') || name.includes('count')) return 1n;
    if (name.includes('tokenid') || name === 'id') {
      throw new Error(`Cannot safely infer required token id parameter "${input.name}".`);
    }
    return 1n;
  }

  throw new Error(`Cannot infer mint argument "${input.name}" of Solidity type "${input.type}".`);
}

function buildMintArguments(fragment) {
  return fragment.inputs.map(inferArgument);
}

function classifyError(error) {
  const text = [error?.code, error?.shortMessage, error?.reason, error?.message, error?.info?.error?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (REVERT_HINTS.userRejected.some((hint) => text.includes(hint))) return '用户在钱包中拒绝了交易签名。';
  if (REVERT_HINTS.soldOut.some((hint) => text.includes(hint))) return 'mint 失败：可能已经 sold out。';
  if (REVERT_HINTS.ended.some((hint) => text.includes(hint))) return 'mint 失败：免费 mint 或 sale 可能已结束/未开启。';
  if (REVERT_HINTS.insufficientFunds.some((hint) => text.includes(hint))) return 'mint 失败：钱包 ETH 不足以支付 mint value 或 gas。';
  if (REVERT_HINTS.nonceTooLow.some((hint) => text.includes(hint))) return 'mint 失败：nonce 过低或交易已在池中。';
  if (text.includes('execution reverted') || error?.code === 'CALL_EXCEPTION') return 'mint 失败：execution reverted，合约拒绝了本次调用。';

  return `mint 失败：${error?.shortMessage || error?.reason || error?.message || 'unknown error'}`;
}

async function ensureMainnet() {
  const network = await provider.getNetwork();
  if (network.chainId === MAINNET_CHAIN_ID) return;

  log(`当前网络 chainId=${network.chainId}，尝试切换到 Ethereum Mainnet...`, 'warn');
  await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
}

async function refreshGasAndBlock(blockNumber) {
  if (blockNumber !== undefined) elements.currentBlock.textContent = String(blockNumber);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  elements.gasPrice.textContent = gasPrice ? `${formatUnits(gasPrice, 'gwei')} gwei` : 'unavailable';
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error('未检测到浏览器钱包。请安装 MetaMask、Rabby 或其他注入式钱包。');
  }

  provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  await ensureMainnet();
  signer = await provider.getSigner();
  walletAddress = await signer.getAddress();
  const network = await provider.getNetwork();

  elements.walletAddress.textContent = walletAddress;
  elements.networkName.textContent = `${network.name} (chainId ${network.chainId})`;
  log(`Connected wallet: ${walletAddress}`);
  await refreshGasAndBlock(await provider.getBlockNumber());

  provider.on('block', handleBlock);
  window.ethereum.on?.('accountsChanged', () => window.location.reload());
  window.ethereum.on?.('chainChanged', () => window.location.reload());
  setButtons();
}

async function loadContract() {
  const address = elements.contractAddress.value.trim() || DEFAULT_CONTRACT_ADDRESS;
  abi = await readAbi(address);
  mintFragment = identifyMintFunction(abi);
  contract = new Contract(address, abi, signer);
  elements.mintFunction.textContent = mintFragment.format('full');
  log(`Selected mint function: ${mintFragment.format('full')}`);
  setButtons();
}

async function attemptMint(blockNumber = 'manual') {
  if (!contract || !mintFragment) throw new Error('请先读取 ABI 并识别 mint 函数。');
  if (pendingWalletPrompt) {
    log('已有钱包确认弹窗或交易处理中，跳过本次区块。', 'warn');
    return;
  }

  pendingWalletPrompt = true;
  setButtons();

  try {
    const args = buildMintArguments(mintFragment);
    const valueText = elements.mintValueEth.value.trim();
    const value = valueText ? parseEther(valueText) : 0n;
    const overrides = { value };

    await refreshGasAndBlock(blockNumber === 'manual' ? undefined : blockNumber);
    log(`Block ${blockNumber}: preparing ${mintFragment.name}(${args.map(String).join(', ')}) with value ${valueText || '0'} ETH`);

    const mintMethod = contract.getFunction(mintFragment.format('sighash'));
    await mintMethod.staticCall(...args, overrides);
    const estimatedGas = await mintMethod.estimateGas(...args, overrides);
    const gasLimit = (estimatedGas * 120n) / 100n;
    log(`Gas estimate: ${estimatedGas.toString()}, using gasLimit ${gasLimit.toString()}`);

    const tx = await mintMethod(...args, { ...overrides, gasLimit });
    elements.lastTx.innerHTML = `<a href="https://etherscan.io/tx/${tx.hash}" target="_blank" rel="noreferrer">${tx.hash}</a>`;
    log(`Transaction submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    if (receipt?.status === 1) {
      log(`mint 成功: ${tx.hash}`);
    } else {
      log(`mint 交易已确认但 status != 1: ${tx.hash}`, 'warn');
    }
  } catch (error) {
    log(classifyError(error), 'error');
  } finally {
    pendingWalletPrompt = false;
    setButtons();
  }
}

async function handleBlock(blockNumber) {
  try {
    await refreshGasAndBlock(blockNumber);
    log(`New block: ${blockNumber}`);
    if (!autoEnabled) return;
    if (attemptedBlocks.has(blockNumber)) return;
    attemptedBlocks.add(blockNumber);
    await attemptMint(blockNumber);
  } catch (error) {
    log(`Block handler error: ${error.message}`, 'error');
  }
}

elements.connectButton.addEventListener('click', async () => {
  try {
    await connectWallet();
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.loadAbiButton.addEventListener('click', async () => {
  try {
    await loadContract();
  } catch (error) {
    log(error.message, 'error');
  }
});

elements.mintNowButton.addEventListener('click', () => attemptMint());
elements.autoButton.addEventListener('click', () => {
  autoEnabled = !autoEnabled;
  log(autoEnabled ? '已开启自动模式：每个新区块尝试一次，但每笔交易仍需钱包手动确认。' : '已关闭自动模式。');
  setButtons();
});

setButtons();
log('Ready. 请先连接浏览器钱包。');
