/** controller-rooted.js
 * Manage rooted non-purchased servers.
 * Flags:
 *   --verbose  => print logs
 *   --silent   => full quiet
 * Default quiet mode = true.
 */

export async function main(ns) {
    const args = ns.args || [];
    let QUIET = true;
    if (args.includes("--verbose")) QUIET = false;
    if (args.includes("--silent")) QUIET = true;

    const log = (...m) => { if (!QUIET) ns.tprint(m.join(" ")); };

    const SCAN_INTERVAL = 30000;
    const PER_SERVER_COOLDOWN = 60000;
    const MIN_RAM_TO_BATCH = 8;

    const HACK_PCT_TIER = { big: 0.02, med: 0.015, small: 0.01 };

    const purchased = () => ns.getPurchasedServers();
    const isPurchased = (s) => purchased().includes(s);

    const serverLastDeploy = {};

    log("controller-rooted.js started (quiet=" + QUIET + ")");

    // ============================================================
    while (true) {
        try {
            const all = scanAll(ns);
            for (const s of all) autoNuke(ns, s);

            const targets = pickTargetsAndStrategy(ns);

            const rooted = all.filter(s => 
                s !== "home" && !isPurchased(s) && ns.hasRootAccess(s)
            );

            for (const server of rooted) {
                const maxRam = ns.getServerMaxRam(server);
                const freeRam = maxRam - ns.getServerUsedRam(server);
                if (maxRam < 2) continue;

                if (Date.now() - (serverLastDeploy[server] || 0) < PER_SERVER_COOLDOWN)
                    continue;

                if (freeRam >= MIN_RAM_TO_BATCH && maxRam >= 8) {
                    const tgt = assignTarget(ns, server, targets);
                    await ns.scp(["host-batcher-smart.js","hack.js","grow.js","weaken.js"], server);
                    const batchRam = ns.getScriptRam("host-batcher-smart.js");
                    if (freeRam < batchRam) continue;

                    let pct = maxRam>=256 ? HACK_PCT_TIER.big :
                              maxRam>=64  ? HACK_PCT_TIER.med :
                                            HACK_PCT_TIER.small;

                    const pid = ns.exec("host-batcher-smart.js", server, 1, tgt, pct);
                    if (pid) {
                        serverLastDeploy[server] = Date.now();
                        log(`🚀 ROOTED ${server} -> ${tgt} (pct=${pct})`);
                    }
                } else {
                    const script = "worker-simple.js";
                    const ram = ns.getScriptRam(script);
                    if (freeRam >= ram) {
                        await ns.scp(script, server);
                        const threads = Math.max(1, Math.floor(freeRam / ram));
                        const tgt = assignTarget(ns, server, targets);
                        const pid = ns.exec(script, server, threads, tgt);
                        if (pid) {
                            serverLastDeploy[server] = Date.now();
                            log(`🟢 tiny-worker ${server} (${threads}t) -> ${tgt}`);
                        }
                    }
                }

                await ns.sleep(10);
            }

            await ns.sleep(SCAN_INTERVAL);

        } catch (err) {
            ns.tprint("controller-rooted ERROR: " + err);
            await ns.sleep(5000);
        }
    }

    // ============================================================
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
        const all = scanAll(ns).filter(s => s!="home" && ns.getServerMaxMoney(s)>0);
        const arr = [];
        for (const s of all) {
            if (ns.getServerRequiredHackingLevel(s) > ns.getHackingLevel()) continue;
            autoNuke(ns, s);
            if (!ns.hasRootAccess(s)) continue;
            arr.push({ s, chance: ns.hackAnalyzeChance(s), sc: score(ns,s) });
        }
        arr.sort((a,b)=>b.sc-a.sc);
        const top = arr.slice(0,10);
        if (top.length === 0) return { primary: null, secondaries: [] };

        const a = top[0], b = top[1] || { sc:0 };
        if (a.chance >= 0.65 && a.sc > b.sc * 1.4)
            return { primary: a.s, secondaries: top.slice(1).map(x=>x.s) };

        return { primary: null, secondaries: top.map(x=>x.s) };
    }

    function assignTarget(ns, server, targets) {
        const ram = ns.getServerMaxRam(server);
        const secs = targets.secondaries || [];

        if (targets.primary) {
            if (ram >= 256 || Math.random() < 0.45)
                return targets.primary;
        }

        if (secs.length === 0)
            return targets.primary || "n00dles";

        const m = server.match(/\d+/);
        return m ? secs[parseInt(m[0]) % secs.length]
                 : secs[Math.floor(Math.random()*secs.length)];
    }
}
