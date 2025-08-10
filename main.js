import fs from 'fs';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import chalk from 'chalk';
import pLimit from 'p-limit';

dotenv.config();

const providerUrl = process.env.RPC_URL || 'https://rpc.kasplextest.xyz';
const keyFile = process.env.PRIVATE_KEY_FILE || 'private_key.txt';
const intervalHours = parseInt(process.env.REPEAT_INTERVAL_HOURS || '24');
const provider = new ethers.providers.JsonRpcProvider(providerUrl);
const concurrencyLimit = parseInt(process.env.CONCURRENCY_LIMIT || '3');
const limit = pLimit(concurrencyLimit);

// ✅ LOG có màu sắc phân loại
const log = (msg, type = 'info') => {
    const timestamp = `[${new Date().toISOString()}]`;
    let colorFunc = chalk.green;

    if (type === 'error') colorFunc = chalk.red;
    else if (type === 'warn') colorFunc = chalk.yellow;
    else if (type === 'swap') colorFunc = chalk.blue;
    else if (type === 'claim') colorFunc = chalk.magenta;
    else if (type === 'success') colorFunc = chalk.cyan;

    console.log(colorFunc(`${timestamp} ${msg}`));
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));
const safeCall = async (fn, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            await delay(1000);
        }
    }
};

const ROUTER = '0xaE821200c01E532E5A252FfCaA8546cbdca342DF';
const WKAS = '0xf40178040278E16c8813dB20a84119A605812FB3';
const FARM_ROUTER = '0x65b0552Be5c62d60EC4a3daCC72894c8F96C619a';
const LP_KANGO = '0xD9737e464Df3625e08a7F3Df61aABFBf523DBCfC';
const PID_KANGO = 1;
const RATE = 0.000781059283943971;
const CLAIM_SELECTOR = '0xde5f72fd';
const MIN_KAS_REQUIRED = ethers.utils.parseEther('0.01');

const TOKENS = [
    { name: 'tNACHO', address: '0xfa458995688c73fc48E7D833483a7206Bed75C27', staking: '0xC5f458f60C3D44256dD7c6290e981C01cd0BBb52' },
    { name: 'tZEAL', address: '0xD6411bc52c8CbD192477233F2DB211cB96bc3504', staking: '0x86264b694c3c3Bc1907ace84DbcF823758E9b948' },
    { name: 'tKASPER', address: '0x521023CA380929046365FcE28f6096263E7f8B8f' },
    { name: 'tKANGO', address: '0x46B4B1A6c462609957D17D5d8eEA12037E44ef3F' },
    { name: 'tBURT', address: '0x0b1793776E43D71Cc892E58849A0D2465FF36f10' },
    { name: 'tKASPY', address: '0x58CE5acc313B3fDC38adf3Ad670122556A44B009' },
    { name: 'tKREX', address: '0x3Cfaf44e511f08D2Ad1049a79E6d5701272D707F' },
    { name: 'tGHOAD', address: '0xd97D0AEc9CB23C3Ed3bBae393e85b542Db3226BF' },
];

const LIQUIDITY_TOKENS = [
    { name: 'xZEAL', address: '0xfEc49b2F52B01d36C40D164A09831Ce69E596b2B' },
    { name: 'xNACHO', address: '0xa2B36605ca53B003a1f1DEb84Fa2D66382ecdba8' },
    { name: 'tKANGO', address: '0x46B4B1A6c462609957D17D5d8eEA12037E44ef3F' },
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function withdraw(uint256) public',
    'function allowance(address,address) view returns (uint256)'
];

const STAKING_ABI = ['function stake(uint256 amount) public returns (bool)'];
const ROUTER_ABI = ['function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) external returns (uint256[])'];
const LIQUIDITY_ABI = ['function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) external returns (uint256,uint256,uint256)'];
const FARM_ABI = ['function deposit(uint256,uint256)'];

const WKAS_EXTRA = ['function deposit() payable'];
async function processWallet(pk) {
    const wallet = new ethers.Wallet(pk, provider);
    const address = wallet.address;
    try {
        const noncePending = await provider.getTransactionCount(address, 'pending');
        const nonceLatest = await provider.getTransactionCount(address, 'latest');

        if (noncePending > nonceLatest) {
            log(`[SKIP] Wallet ${address} has pending transaction(s) in mempool`, 'warn');
            return;
        }
    } catch (err) {
        log(`[ERROR] Failed to check nonce for ${address} → ${err.message}`, 'error');
        return;
    }
    log(`Processing wallet: ${address}`);

    const noncePending = await provider.getTransactionCount(address, 'pending');
    const nonceLatest = await provider.getTransactionCount(address, 'latest');

    if (noncePending > nonceLatest) {
        log(`[SKIP] Wallet ${address} has pending transaction(s) in mempool`, 'warn');
        return;
    }
    const kasBalance = await provider.getBalance(address);
    const kasFormatted = ethers.utils.formatEther(kasBalance);
    log(`[INFO] Wallet ${address} KAS Balance: ${kasFormatted}`);

    if (kasBalance.lt(MIN_KAS_REQUIRED)) {
        log(`[SKIP] Wallet ${address} has less than 0.01 KAS. Skipping...`);
        return;
    }

    //--- Faucet Claim-- -
    const claimedFile = 'claimed_wallets.txt';
    const claimedWallets = fs.existsSync(claimedFile)
        ? new Set(fs.readFileSync(claimedFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))
        : new Set();

    if (!claimedWallets.has(address)) {
        for (const token of TOKENS) {
            const txRequest = {
                to: token.address,
                data: CLAIM_SELECTOR,
                gasLimit: 100000,
            };

            try {
                await Promise.race([
                    provider.call({ ...txRequest, from: address }),
                    delay(5000).then(() => { throw new Error('Call simulation timeout') })
                ]);
            } catch (err) {
                log(`[CLAIM SKIP] ${token.name}: call simulation failed → ${err.reason || err.message}`);
                continue;
            }

            try {
                const tx = await wallet.sendTransaction(txRequest);
                log(`[CLAIM] ${token.name} | TX: ${tx.hash}`);

                const receipt = await Promise.race([
                    tx.wait(),
                    delay(10000).then(() => { throw new Error('TX confirmation timeout') })
                ]);

                if (receipt && receipt.status === 1) {
                    log(`[CLAIM CONFIRMED] ${token.name} TX: ${tx.hash}`);
                } else {
                    log(`[CLAIM FAILED] ${token.name} TX: ${tx.hash}`);
                }

            } catch (sendErr) {
                log(`[CLAIM SEND ERROR] ${token.name}: ${sendErr.reason || sendErr.message}`);
            }
        }

        fs.appendFileSync(claimedFile, address + '\n');
        claimedWallets.add(address);
    } else {
        log(`[CLAIM SKIP] ${address} already claimed`);
    }

    // --- Auto swap KAS to needed tokens if balance is 0 ---
    const mustHaveTokens = ['tNACHO', 'tZEAL', 'tKANGO'];
    const kasToTokenSwapPercent = 0.03;

    for (const name of mustHaveTokens) {
        const token = TOKENS.find(t => t.name === name);
        const tokenC = new ethers.Contract(token.address, ERC20_ABI, wallet);
        const tokenBalance = await tokenC.balanceOf(address);

        if (tokenBalance.isZero()) {
            const kasToUse = kasBalance.mul(Math.floor(kasToTokenSwapPercent * 100)).div(100);
            const wrappedKAS = new ethers.Contract(WKAS, ['function deposit() payable'], wallet);

            // Wrap KAS
            const depositTx = await wrappedKAS.deposit({ value: kasToUse, gasLimit: 100000 });
            log(`[WRAP KAS] Wrapping ${ethers.utils.formatEther(kasToUse)} KAS → WKAS | TX: ${depositTx.hash}`);
            await depositTx.wait();

            const wkas = new ethers.Contract(WKAS, ERC20_ABI, wallet);
            const allowance = await wkas.allowance(address, ROUTER);

            if (allowance.lt(kasToUse)) {
                const approveTx = await wkas.approve(ROUTER, kasToUse);
                log(`[SWAP-FILL] Approving WKAS for ${name} | TX: ${approveTx.hash}`);
                await approveTx.wait();
            }

            const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            const path = [WKAS, token.address];

            try {
                await router.callStatic.swapExactTokensForTokens(
                    kasToUse,
                    0,
                    path,
                    address,
                    deadline
                );
            } catch (callErr) {
                log(`[SWAP-FILL SKIP] Route WKAS → ${name} not available: ${callErr.reason || callErr.message}`, 'warn');
                continue;
            }

            try {
                const swapTx = await router.swapExactTokensForTokens(
                    kasToUse,
                    0,
                    path,
                    address,
                    deadline,
                    { gasLimit: 500000 }
                );
                log(`[SWAP-FILL] KAS → ${name} | TX: ${swapTx.hash}`);
                await swapTx.wait();
            } catch (err) {
                log(`[SWAP-FILL ERROR] Failed to swap WKAS to ${name}: ${err.reason || err.message}`, 'error');
            }
        }
    }

    // --- Swap tokens ---
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    const exclude = ['tNACHO', 'tZEAL', 'tKANGO']; // muốn loại bỏ token nào không swap add thêm vào đây 

    for (const token of TOKENS.filter(t => !exclude.includes(t.name))) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        const wkas = new ethers.Contract(WKAS, ERC20_ABI, wallet);

        try {
            const [balance, decimals, symbol] = await Promise.all([
                contract.balanceOf(address),
                contract.decimals(),
                contract.symbol()
            ]);

            const balanceFormatted = Number(ethers.utils.formatUnits(balance, decimals));
            log(`[SWAP CHECK] ${token.name}: ${balanceFormatted}`);

            if (balanceFormatted < 5000) {
                log(`[SWAP SKIP] ${token.name}: balance too low`);
                continue;
            }

            const useAmount = balance.div(5); // chỉ dùng 20%
            const approveTx = await contract.approve(ROUTER, balance);
            log(`[SWAP] Approving ${token.name} - TX: ${approveTx.hash}`);
            await approveTx.wait();

            const path = [token.address, WKAS];
            const deadline = Math.floor(Date.now() / 1000) + 600;

            try {
                const tx = await router.swapExactTokensForTokens(
                    balance,
                    0,
                    path,
                    address,
                    deadline,
                    { gasLimit: 300000 }
                );
                log(`[SWAP] ${token.name} → WKAS | TX: ${tx.hash}`);

                const receipt = await tx.wait();
                if (receipt.status !== 1) {
                    log(`[SWAP TX ERROR] ${token.name}: transaction reverted | TX: ${tx.hash}`);
                    continue;
                }
            } catch (err) {
                if (err.code === 'REPLACED' && err.replacement) {
                    const replacedTx = err.replacement;
                    log(`[SWAP REPLACED] ${token.name}: TX replaced → New TX: ${replacedTx.hash}`);

                    const repReceipt = await replacedTx.wait();
                    if (repReceipt.status === 1) {
                        log(`[SWAP REPLACEMENT CONFIRMED] ${token.name} | TX: ${replacedTx.hash}`);
                    } else {
                        log(`[SWAP REPLACEMENT FAILED] ${token.name} | TX: ${replacedTx.hash}`);
                    }
                } else {
                    log(`[SWAP ERROR] ${token.name}: ${err.reason || err.message}`);
                }
                continue;
            }

            // Unwrap WKAS back to KAS

            const wbal = await wkas.balanceOf(address);
            if (wbal.gt(0)) {
                const unwrapTx = await wkas.withdraw(wbal);
                log(`[UNWRAP] WKAS → KAS | TX: ${unwrapTx.hash}`);
                await unwrapTx.wait();
            }

        } catch (err) {
            log(`[SWAP EXCEPTION] ${token.name}: ${err.reason || err.message}`);
        }
    }

    for (const token of TOKENS.filter(t => t.staking)) {
        const tokenC = new ethers.Contract(token.address, ERC20_ABI, wallet);
        const stakeC = new ethers.Contract(token.staking, STAKING_ABI, wallet);

        try {
            const bal = await tokenC.balanceOf(address);
            if (bal.eq(0)) {
                log(`[STAKE SKIP] ${token.name}: no balance`);
                continue;
            }

            const half = bal.div(10);// sô lượng stake 
            const allowance = await tokenC.allowance(address, token.staking);

            if (allowance.lt(half)) {
                const approveTx = await tokenC.approve(token.staking, half);
                log(`[STAKE] Approving ${token.name} for staking - TX: ${approveTx.hash}`);
                await approveTx.wait();
            }

            try {
                const tx = await stakeC.stake(half, { gasLimit: 200000 });
                log(`[STAKE] 10% ${token.name} | TX: ${tx.hash}`);

                const receipt = await tx.wait();
                if (receipt.status !== 1) {
                    log(`[STAKE TX ERROR] ${token.name}: transaction reverted | TX: ${tx.hash}`);
                }
            } catch (err) {
                if (err.code === 'REPLACED' && err.replacement) {
                    const rep = err.replacement;
                    log(`[STAKE REPLACED] ${token.name} → New TX: ${rep.hash}`);
                    const repReceipt = await rep.wait();
                    if (repReceipt.status === 1) {
                        log(`[STAKE REPLACEMENT CONFIRMED] ${token.name} | TX: ${rep.hash}`);
                    } else {
                        log(`[STAKE REPLACEMENT FAILED] ${token.name} | TX: ${rep.hash}`);
                    }
                } else {
                    log(`[STAKE ERROR] ${token.name}: ${err.reason || err.message}`);
                }
            }

        } catch (err) {
            log(`[STAKE EXCEPTION] ${token.name}: ${err.reason || err.message}`);
        }
    }



    // --- Add Liquidity ---

    async function ensureApprove(token, owner, spender, amount) {
        const allowance = await safeCall(() => token.allowance(owner, spender));
        if (allowance.lt(amount)) {
            let sym = '';
            try { sym = await safeCall(() => token.symbol()); } catch { }
            const tx = await token.approve(spender, amount);
            log(`${owner} Approving ${sym || ''} → ${spender} | TX: ${tx.hash}`);
            await tx.wait(); await delay(1000);
        }
    }

    async function wrapIfNeeded(wallet, amount) {
        const wkas = new ethers.Contract(WKAS, ['function deposit() payable', 'function balanceOf(address) view returns (uint256)'], wallet);
        const current = await provider.getBalance(wallet.address);
        const wrapped = await wkas.balanceOf(wallet.address);

        if (wrapped.gte(amount)) return true;

        const missing = amount.sub(wrapped);
        if (current.lt(missing)) return false;

        const tx = await wkas.deposit({ value: missing, gasLimit: 100000 });
        log(`${wallet.address} Wrapped ${ethers.utils.formatEther(missing)} KAS → WKAS | TX: ${tx.hash}`);
        await tx.wait();
        return true;
    }


    async function printBalances(wallet) {
        const kas = await safeCall(() => provider.getBalance(wallet.address));
        const w = new ethers.Contract(WKAS, ERC20, wallet);
        const wkas = await safeCall(() => w.balanceOf(wallet.address));
        log(`${wallet.address} Bal → KAS:${ethers.utils.formatEther(kas)}, WKAS:${ethers.utils.formatEther(wkas)}`);
        const TOKENS = [{ n: 'xZEAL', a: XZEAL }, { n: 'xNACHO', a: XNACHO }, { n: 'tKANGO', a: TKANGO }];
        for (const t of TOKENS) {
            const tk = new ethers.Contract(t.a, ERC20, wallet);
            try {
                const bal = await safeCall(() => tk.balanceOf(wallet.address));
                const dec = await safeCall(() => tk.decimals());
                log(`${wallet.address} ${t.n}: ${ethers.utils.formatUnits(bal, dec)}`);
            } catch {
                log(`${wallet.address} ${t.n}: balanceFailed`);
            }
        }
    }

    async function addLiquidityPair(wallet, tokenAddr, name) {
        const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
        const wkas = new ethers.Contract(WKAS, ERC20_ABI, wallet);
        const router = new ethers.Contract(ROUTER, LIQUIDITY_ABI, wallet);

        const bal = await safeCall(() => token.balanceOf(wallet.address));
        const dec = await safeCall(() => token.decimals());

        if (bal.isZero()) {
            log(`[LIQUIDITY SKIP] ${wallet.address} No ${name} balance`);
            return;
        }

        const sym = await safeCall(() => token.symbol()).catch(() => name);
        const useT = bal.div(20); // dùng 10%
        const reqW = ethers.utils.parseUnits(
            (parseFloat(ethers.utils.formatUnits(useT, dec)) * RATE).toString(),
            await safeCall(() => wkas.decimals())
        );

        log(`[LIQUIDITY] ${wallet.address} ${sym}: need ~${ethers.utils.formatEther(reqW)} WKAS for ${ethers.utils.formatUnits(useT, dec)} tokens`);

        if (!(await wrapIfNeeded(wallet, reqW))) {
            log(`[LIQUIDITY SKIP] ${wallet.address} Not enough KAS to wrap for ${sym}`);
            return;
        }

        const finalW = await safeCall(() => wkas.balanceOf(wallet.address));
        const useW = finalW.lt(reqW) ? finalW : reqW;

        await ensureApprove(wkas, wallet.address, ROUTER, useW);
        await ensureApprove(token, wallet.address, ROUTER, useT);

        const deadline = Math.floor(Date.now() / 1000) + 600;
        const gas = await safeCall(() => provider.getGasPrice());

        try {
            const tx = await router.functions.addLiquidity(
                WKAS,
                tokenAddr,
                useW,
                useT,
                0,
                0,
                wallet.address,
                deadline,
                { gasLimit: 400000, gasPrice: gas.mul(110).div(100) }
            );
            log(`[LIQUIDITY] ${wallet.address} [${sym}] addLiquidity TX: ${tx.hash}`);
            await tx.wait();
            await delay(1000);
        } catch (err) {
            log(`[LIQUIDITY ERROR] ${wallet.address} [${sym}]: ${err.reason || err.message}`);
        }
    }
    for (const token of LIQUIDITY_TOKENS) {
        await addLiquidityPair(wallet, token.address, token.name);
    }

    //Fa}m
    try {
        const lp = new ethers.Contract(LP_KANGO, ERC20_ABI, wallet);
        const farm = new ethers.Contract(FARM_ROUTER, FARM_ABI, wallet);
        const amt = await lp.balanceOf(address);

        log(`[FARM] ${wallet.address} LP Balance: ${ethers.utils.formatEther(amt)}`, 'info');

        if (amt.gt(0)) {
            const allowance = await lp.allowance(address, FARM_ROUTER);
            if (allowance.lt(amt)) {
                const approveTx = await lp.approve(FARM_ROUTER, amt);
                log(`[FARM] Approving LP | TX: ${approveTx.hash}`, 'swap');
                await approveTx.wait();
            }

            try {
                await farm.callStatic.deposit(PID_KANGO, amt);
            } catch (e) {
                log(`[FARM ERROR] callStatic failed → ${e.reason || e.message}`, 'error');
                return;
            }

            try {
                const tx = await farm.deposit(PID_KANGO, amt, { gasLimit: 300000 });
                log(`[FARM] LP Deposited | TX: ${tx.hash}`, 'success');
                await tx.wait();
            } catch (err) {
                log(`[FARM ERROR] TX failed → ${err.reason || err.message}`, 'error');
            }
        } else {
            log(`[FARM] No LP balance to deposit`, 'warn');
        }
    } catch (err) {
        log(`[FARM ERROR]: ${err.reason || err.message}`, 'error');
    }
}

async function mainLoop() {
    const keys = fs.readFileSync(keyFile, 'utf8')
        .split('\n').map(s => s.trim()).filter(Boolean);

    log(`Starting batch for ${keys.length} wallets with concurrency ${concurrencyLimit}`);

    while (true) {
        try {
            const tasks = keys.map(pk =>
                limit(() => processWallet(pk).catch(err => log(`[ERROR] wallet ${pk.slice(0, 6)}... → ${err.message}`)))
            );
            await Promise.all(tasks);
            log(`Done batch, waiting ${intervalHours}h before next run`);
        } catch (e) {
            log(`[FATAL ERROR in loop] → ${e.message}`, 'error');
        }
        await delay(intervalHours * 3600 * 1000);
    }

}


mainLoop().catch(console.error);