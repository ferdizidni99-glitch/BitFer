/** controller-purchased.js
 * Manage purchased servers with host-batcher-smart.js
 * Supports:
 *   --verbose  => print all logs
 *   --silent   => print nothing
 * Default: QUIET = true
 */

/** @param {NS} ns */
export async function main(ns) {
    // ---- FLAGS ----
    const args = ns.args || [];
    let QUIET = true; // default
    if (args.includes("--verbose")) QUIET = false;
    if (args.includes("--silent")) QUIET = true;

    const log = (...m) => { if (!QUIET) ns.tprint(m.join(" ")); };

    // ---- CONFIG ----
    const BUY_COOLDOWN = 10 * 60 * 1000;
    const PER_SERVER_COOLDOWN = 2 * 60 * 1000;
    const INITIAL_RAM = 8;
    const MAX_RAM_CAP = 2048;
    const DEPLOY_STAGGER_MS = 200;
    const RESERVED_HOME_PCT = 0.12;

    const HACK_PCT_TIER = {
        large: 0.025,
        mid: 0.02,
        small: 0.015,
        micro: 0.01
    };

    const limit = ns.getPurchasedServerLimit();
    let baseRam = INITIAL_RAM;
    let lastGlobalBuy = 0;
    const serverLastBuy = {};
    const serverLastDeploy = {};

    log(`controller-purchased.js started (limit=${limit}, quiet=${QUIET})`);

    // ========================================================================
    while (true) {
        try {
            const now = Date.now();
            const homeMoney = ns.getServerMoneyAvailable("home");

            const reserved = homeMoney * RESERVED_HOME_PCT;
            const usable = Math.max(0, homeMoney - reserved);

            // auto-nuke & scan
            const all = scanAll(ns);
            for (const s of all) autoNuke(ns, s);

            const targets = pickTargetsAndStrategy(ns);

            // loop purchased servers
            for (let i = 0; i < limit; i++) {
                const name = `pserv-${i}`;
                const exists = ns.serverExists(name);
                const curRam = exists ? ns.getServerMaxRam(name) : 0;

                const canBuyGlobal = (now - lastGlobalBuy >= BUY_COOLDOWN);
                const canBuyServer = (now - (serverLastBuy[name] || 0) >= PER_SERVER_COOLDOWN);
                const cost = ns.getPurchasedServerCost(baseRam);
                const canAfford = cost <= usable * 0.5;

                // BUY
                if (!exists) {
                    if (canAfford && canBuyGlobal && canBuyServer) {
                        ns.purchaseServer(name, baseRam);
                        log(`🆕 BUY ${name} @ ${baseRam}GB`);
                        serverLastBuy[name] = Date.now();
                        lastGlobalBuy = Date.now();
                        await deployBatch(ns, name, targets, serverLastDeploy, log);
                    }
                    continue;
                }

                // UPGRADE
                if (curRam < baseRam) {
                    if (canAfford && canBuyGlobal && canBuyServer) {
                        ns.killall(name);
                        ns.deleteServer(name);
                        ns.purchaseServer(name, baseRam);
                        log(`⬆️ UPGRADE ${name} -> ${baseRam}GB`);
                        serverLastBuy[name] = Date.now();
                        lastGlobalBuy = Date.now();
                        await deployBatch(ns, name, targets, serverLastDeploy, log);
                    }
                    continue;
                }

                // REDEPLOY if needed
                const assigned = assignTargetForServer(ns, name, targets);
                const running = ns.ps(name).some(p => p.filename === "host-batcher-smart.js");
                const allowDeploy = (Date.now() - (serverLastDeploy[name] || 0)) >= PER_SERVER_COOLDOWN;

                if (!running && allowDeploy) {
                    await deployBatch(ns, name, targets, serverLastDeploy, log);
                } else if (running) {
                    const p = ns.ps(name).find(p => p.filename === "host-batcher-smart.js");
                    if (p && p.args[0] !== assigned && allowDeploy) {
                        ns.killall(name);
                        await deployBatch(ns, name, targets, serverLastDeploy, log);
                    }
                }

                await ns.sleep(20);
            }

            // Auto-scale RAM
            if (pservAllAt(ns, baseRam) && baseRam < MAX_RAM_CAP) {
                baseRam *= 2;
                log(`🔼 Auto-scale purchased RAM -> ${baseRam}GB`);
            }

            await ns.sleep(5000);

        } catch (err) {
            ns.tprint("controller-purchased ERROR: " + err);
            await ns.sleep(5000);
        }
    }

    // ========================================================================
    // Utility helpers
    async function deployBatch(ns, server, targets, lastDeployMap, log) {
        try {
            const assigned = assignTargetForServer(ns, server, targets);
            ns.killall(server);
            await ns.scp(["host-batcher-smart.js","hack.js","grow.js","weaken.js"], server);

            const ram = ns.getServerMaxRam(server);
            let hackPct =
                ram >= 1024 ? HACK_PCT_TIER.large :
                ram >= 256 ? HACK_PCT_TIER.mid :
                ram >= 64  ? HACK_PCT_TIER.small :
                              HACK_PCT_TIER.micro;

            const pid = ns.exec("host-batcher-smart.js", server, 1, assigned, hackPct);
            if (pid) log(`🚀 DEPLOY ${server} -> ${assigned} (hackPct=${hackPct})`);
            lastDeployMap[server] = Date.now();
            await ns.sleep(DEPLOY_STAGGER_MS);
        } catch (e) {
            log("deploy error", server, e);
        }
    }

    function pservAllAt(ns, ram) {
        const ps = ns.getPurchasedServers();
        return ps.length > 0 && ps.every(s => ns.getServerMaxRam(s) >= ram);
    }

    // shared helpers
    function scanAll(ns) {
        const seen = new Set(["home"]);
        const stack = ["home"];
        while (stack.length) {
            const h = stack.pop();
            for (const n of ns.scan(h)) if (!seen.has(n)) seen.add(n), stack.push(n);
        }
        return [...seen];
    }

    function autoNuke(ns, s) {
        try {
            if (s === "home" || ns.hasRootAccess(s)) return;
            if (ns.fileExists("BruteSSH.exe")) ns.brutessh(s);
            if (ns.fileExists("FTPCrack.exe")) ns.ftpcrack(s);
            if (ns.fileExists("relaySMTP.exe")) ns.relaysmtp(s);
            if (ns.fileExists("HTTPWorm.exe")) ns.httpworm(s);
            if (ns.fileExists("SQLInject.exe")) ns.sqlinject(s);
            ns.nuke(s);
        } catch {}
    }

    function score(ns, s) {
        const max = ns.getServerMaxMoney(s);
        const chance = ns.hackAnalyzeChance(s);
        const req = ns.getServerRequiredHackingLevel(s);
        return (max * chance) / (1 + req/10);
    }

    function pickTargetsAndStrategy(ns) {
        const all = scanAll(ns).filter(s => s !== "home" && ns.getServerMaxMoney(s) > 0);
        const arr = [];
        for (const s of all) {
            if (ns.getServerRequiredHackingLevel(s) > ns.getHackingLevel()) continue;
            autoNuke(ns, s);
            if (!ns.hasRootAccess(s)) continue;
            arr.push({ s, chance: ns.hackAnalyzeChance(s), sc: score(ns, s) });
        }
        arr.sort((a,b)=>b.sc-a.sc);
        const top = arr.slice(0,10);
        if (top.length === 0) return { primary: null, secondaries: [] };

        const a = top[0], b = top[1] || { sc:0 };
        if (a.chance >= 0.65 && a.sc > b.sc * 1.4)
            return { primary: a.s, secondaries: top.slice(1).map(x=>x.s) };

        return { primary: null, secondaries: top.map(x=>x.s) };
    }

    function assignTargetForServer(ns, server, targets) {
        const ram = ns.getServerMaxRam(server);
        const secs = targets.secondaries || [];

        if (targets.primary) {
            if (ram >= 256 || Math.random() < 0.5)
                return targets.primary;
        }

        if (secs.length === 0)
            return targets.primary || "n00dles";

        const m = server.match(/pserv-(\d+)/);
        return m ? secs[parseInt(m[1]) % secs.length] : secs[Math.floor(Math.random()*secs.length)];
    }
}
