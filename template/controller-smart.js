/** controller-smart.js
 * Controller yang deploy host-batcher-smart.js (1 thread per purchased server)
 * - Smart target selection (primary + secondaries)
 * - Assign servers by RAM tier
 * - Per-server hack% tuning
 *
 * Usage: run controller-smart.js
 */

/** @param {NS} ns */
export async function main(ns) {
    // ========== CONFIG ==========
    const QUIET = true; // false = show tprints
    const BUY_COOLDOWN = 10 * 60 * 1000; // 10 min global cooldown
    const PER_SERVER_COOLDOWN = 2 * 60 * 1000; // per-server cooldown
    const INITIAL_RAM = 8;
    const MAX_RAM_CAP = 2048;
    const DEPLOY_STAGGER_MS = 250;
    const RESERVED_HOME_PCT = 0.12; // keep some cash in home (safety)
    const PRIMARY_DOMINANCE_RATIO = 1.4; // for deciding single-target
    const MIN_HACK_CHANCE_PRIMARY = 0.65;
    const MIN_HACK_CHANCE_SECONDARY = 0.45;

    // tier-based default hack% (per-batch basis; host-batcher-smart will compute concurrency)
    const HACK_PCT_TIER = {
        large: 0.025,   // >= 1024GB
        mid: 0.02,      // 256..1023
        small: 0.015,   // 64..255
        micro: 0.01     // <64
    };

    // ========== HELPERS ==========
    const log = (...m) => { if (!QUIET) ns.tprint(m.join(" ")); };
    function fmtMoney(v) {
        if (typeof ns.formatMoney === "function") return ns.formatMoney(v);
        if (typeof ns.formatNumber === "function") return "$" + ns.formatNumber(v);
        return "$" + Math.round(v);
    }

    // ========== STATE ==========
    const limit = ns.getPurchasedServerLimit();
    let baseRam = INITIAL_RAM;
    let lastTargetSnapshot = { primary: null, secondaries: [] };
    let lastGlobalBuy = 0;
    const serverLastBuy = {};
    const serverLastDeploy = {};

    log("controller-smart started (limit:", limit, "initialRam:", INITIAL_RAM, ")");

    // main loop
    while (true) {
        try {
            const now = Date.now();
            const homeMoney = ns.getServerMoneyAvailable("home");
            const reserved = homeMoney * RESERVED_HOME_PCT;
            const usableMoney = Math.max(0, homeMoney - reserved);

            // scan & nuke quickly
            const all = scanAll(ns);
            for (const s of all) autoNuke(ns, s);

            // pick targets + strategy
            const targets = pickTargetsAndStrategy(ns);
            // snapshot for debug/compare
            if ((targets.primary || null) !== (lastTargetSnapshot.primary || null)) {
                log("Targets chosen:", "primary=", targets.primary, "secondaries=", JSON.stringify(targets.secondaries.slice(0,6)));
            }
            lastTargetSnapshot = targets;

            // purchase/upgrades & deploy loop
            for (let i = 0; i < limit; i++) {
                const name = `pserv-${i}`;
                const exists = ns.serverExists(name);
                const curRam = exists ? ns.getServerMaxRam(name) : 0;

                const canBuyGlobal = (now - lastGlobalBuy) >= BUY_COOLDOWN;
                const lastBuy = serverLastBuy[name] || 0;
                const canBuyServer = (now - lastBuy) >= PER_SERVER_COOLDOWN;

                const costForBase = ns.getPurchasedServerCost(baseRam);
                const canAfford = costForBase <= usableMoney * 0.5; // only use up to 50% of usableMoney for server buy

                // BUY NEW
                if (!exists) {
                    if (canAfford && canBuyGlobal && canBuyServer) {
                        const id = ns.purchaseServer(name, baseRam);
                        if (id) {
                            serverLastBuy[name] = Date.now();
                            lastGlobalBuy = Date.now();
                            log(`🆕 Beli ${name} @ ${baseRam}GB (cost ${fmtMoney(costForBase)})`);
                            await deployHostBatcher(ns, name, targets, serverLastDeploy, log);
                        } else {
                            log(`❌ Gagal beli ${name}`);
                        }
                    }
                    continue;
                }

                // UPGRADE (delete & repurchase)
                if (curRam < baseRam) {
                    if (canAfford && canBuyGlobal && canBuyServer) {
                        ns.killall(name);
                        await ns.sleep(150);
                        ns.deleteServer(name);
                        await ns.sleep(150);
                        ns.purchaseServer(name, baseRam);
                        serverLastBuy[name] = Date.now();
                        lastGlobalBuy = Date.now();
                        log(`⬆️ Upgrade ${name} -> ${baseRam}GB`);
                        await ns.sleep(150);
                        await deployHostBatcher(ns, name, targets, serverLastDeploy, log);
                    }
                    continue;
                }

                // REDEPLOY / ASSIGN if necessary
                // find assigned target for this server
                const assigned = assignTargetForServer(ns, name, targets);
                const running = ns.ps(name).some(p => p.filename === "host-batcher-smart.js");
                const deployCooldown = serverLastDeploy[name] || 0;
                const canDeployNow = (Date.now() - deployCooldown) > PER_SERVER_COOLDOWN;

                if (!running && canDeployNow) {
                    await deployHostBatcher(ns, name, targets, serverLastDeploy, log);
                } else if (running) {
                    // check if current host-batcher runs for different target -> redeploy
                    const procs = ns.ps(name);
                    const hb = procs.find(p => p.filename === "host-batcher-smart.js");
                    if (hb) {
                        const args = hb.args || [];
                        const currTarget = args[0] || null;
                        if (currTarget !== assigned && canDeployNow) {
                            ns.killall(name);
                            await ns.sleep(120);
                            await deployHostBatcher(ns, name, targets, serverLastDeploy, log);
                        }
                    }
                }

                await ns.sleep(30); // tiny yield
            }

            // scale RAM auto
            if (purchasedServersHave(ns, baseRam) && baseRam < MAX_RAM_CAP) {
                baseRam = Math.min(baseRam * 2, MAX_RAM_CAP);
                log(`🔼 target baseRam naik -> ${baseRam}GB`);
            }

            await ns.sleep(5000);
        } catch (e) {
            ns.tprint("controller-smart error: " + String(e));
            await ns.sleep(5000);
        }
    }

    // ==================== helper: deploy host-batcher-smart ====================
    async function deployHostBatcher(ns, server, targets, lastDeployMap, log) {
        try {
            // determine assigned target and hackPercent for this server
            const assigned = assignTargetForServer(ns, server, targets);
            if (!assigned) {
                log(`Skip deploy ${server}: no assigned target`);
                return false;
            }

            ns.killall(server);
            await ns.sleep(100);
            // copy scripts
            await ns.scp(["host-batcher-smart.js", "hack.js", "grow.js", "weaken.js"], server);
            await ns.sleep(60);

            // compute hackPercent based on server RAM tier
            const ram = ns.getServerMaxRam(server);
            let hackPct = HACK_PCT_TIER.micro;
            if (ram >= 1024) hackPct = HACK_PCT_TIER.large;
            else if (ram >= 256) hackPct = HACK_PCT_TIER.mid;
            else if (ram >= 64) hackPct = HACK_PCT_TIER.small;

            // check free RAM before exec
            const freeRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
            const batcherRam = ns.getScriptRam("host-batcher-smart.js");
            if (freeRam < batcherRam) {
                log(`Skip deploy ${server}: freeRam ${freeRam} < batcherRam ${batcherRam}`);
                return false;
            }

            const pid = ns.exec("host-batcher-smart.js", server, 1, assigned, hackPct);
            if (!pid) {
                log(`❌ Exec host-batcher-smart failed on ${server}`);
                return false;
            }
            lastDeployMap[server] = Date.now();
            log(`🚀 ${server} -> ${assigned} (hack% ${hackPct}) pid=${pid}`);
            await ns.sleep(DEPLOY_STAGGER_MS);
            return true;
        } catch (e) {
            log(`deployHostBatcher error ${server}: ${e && e.message ? e.message : e}`);
            return false;
        }
    }

    // ==================== helper: target selection ====================
    function scanAll(ns) {
        const seen = new Set(["home"]);
        const stack = ["home"];
        while (stack.length) {
            const h = stack.pop();
            for (const n of ns.scan(h)) {
                if (!seen.has(n)) { seen.add(n); stack.push(n); }
            }
        }
        return [...seen];
    }

    function candidateScore(ns, s) {
        const maxMoney = ns.getServerMaxMoney(s);
        const chance = ns.hackAnalyzeChance(s);
        const req = ns.getServerRequiredHackingLevel(s);
        if (maxMoney <= 0 || chance <= 0) return 0;
        return (maxMoney * chance) / (1 + req / 10);
    }

    function pickTargetsAndStrategy(ns) {
        const POOL = 12;
        const all = scanAll(ns).filter(s => s !== "home" && ns.getServerMaxMoney(s) > 0);
        const cand = [];
        for (const s of all) {
            try {
                if (ns.getServerRequiredHackingLevel(s) > ns.getHackingLevel()) continue;
                autoNuke(ns, s);
                if (!ns.hasRootAccess(s)) continue;
                const chance = ns.hackAnalyzeChance(s);
                if (chance <= 0) continue;
                const score = candidateScore(ns, s);
                cand.push({ s, score, chance });
            } catch (_) {}
        }
        cand.sort((a,b) => b.score - a.score);
        const top = cand.slice(0, POOL);

        if (top.length === 0) return { primary: null, secondaries: [] };
        const top1 = top[0];
        const top2 = top[1] || { score: 0, chance: 0 };

        // decide single-target primary if dominant and high chance
        if (top1.chance >= MIN_HACK_CHANCE_PRIMARY && top1.score > top2.score * PRIMARY_DOMINANCE_RATIO) {
            const secondaries = top.slice(1, Math.min(top.length, 8)).map(x => x.s);
            return { primary: top1.s, secondaries };
        }

        // otherwise multi-target (take those with decent chance)
        const secondaries = top.filter(t => t.chance >= MIN_HACK_CHANCE_SECONDARY).map(x => x.s);
        if (secondaries.length === 0) return { primary: top1.s, secondaries: [] };
        return { primary: null, secondaries };
    }

    // ==================== helper: assign server to target ====================
    function assignTargetForServer(ns, serverName, targets) {
        // targets = { primary: string|null, secondaries: [..] }
        const ram = ns.getServerMaxRam(serverName);
        const secs = targets.secondaries || [];

        // prefer primary on big hosts
        if (targets.primary) {
            if (ram >= 1024) return targets.primary;     // big hosts -> primary
            if (ram >= 256 && Math.random() < 0.7) return targets.primary; // medium often
            if (ram >= 64 && Math.random() < 0.35) return targets.primary; // small sometimes
        }

        // if no secondaries, fallback to primary or n00dles
        if (!secs || secs.length === 0) return targets.primary || "n00dles";

        // stable assignment: server index modulo secondaries
        const m = serverName.match(/pserv-(\d+)/);
        let idx = 0;
        if (m) idx = parseInt(m[1], 10) % secs.length;
        else idx = Math.floor(Math.random() * secs.length);
        return secs[idx];
    }

    // ==================== helper: purchasedServersHave ====================
    function purchasedServersHave(ns, ram) {
        const ps = ns.getPurchasedServers();
        if (!ps || ps.length === 0) return false;
        return ps.every(s => ns.getServerMaxRam(s) >= ram);
    }

    // ==================== helper: autoNuke ====================
    function autoNuke(ns, server) {
        try {
            if (server === "home") return;
            if (ns.hasRootAccess(server)) return;
            if (ns.fileExists("BruteSSH.exe")) ns.brutessh(server);
            if (ns.fileExists("FTPCrack.exe")) ns.ftpcrack(server);
            if (ns.fileExists("relaySMTP.exe")) ns.relaysmtp(server);
            if (ns.fileExists("HTTPWorm.exe")) ns.httpworm(server);
            if (ns.fileExists("SQLInject.exe")) ns.sqlinject(server);
            ns.nuke(server);
        } catch (_) {}
    }
}
