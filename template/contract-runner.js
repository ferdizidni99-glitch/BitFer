/** contract-runner.js
 * Runs on a server, finds .cct contract files and:
 *  - if /home/contract-solver.js exists -> runs it: ns.exec("contract-solver.js", host, 1, server, contractFile)
 *  - else logs contract metadata to /tmp/contracts.json for later solving
 *
 * Usage: run contract-runner.js
 */

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    const OUTPUT = "/tmp/contracts.json";
    while (true) {
        try {
            const host = ns.getHostname();
            // list contract files on this host
            const allContracts = ns.ls(host).filter(f => f.endsWith(".cct"));
            if (allContracts.length === 0) {
                // nothing to do
                await ns.sleep(60000);
                continue;
            }

            const solverExists = ns.fileExists("contract-solver.js", "home");
            for (const c of allContracts) {
                try {
                    // if solver present in home, exec it (pass server + contract filename)
                    if (solverExists) {
                        ns.tprint(`contract-runner: launching solver for ${c} on ${host}`);
                        ns.exec("contract-solver.js", "home", 1, host, c); // run solver on home
                        // optionally you could run solver on this host; using home keeps solver in a stable place
                    } else {
                        // collect info and append to file for manual solving later
                        const data = { server: host, file: c, time: Date.now(), type: "" };
                        try {
                            // read first line of contract to attempt to identify type (some versions include type as header)
                            // fallback: ns.codingcontract.getContractType exists in newer versions but may be limited
                            if (typeof ns.codingcontract === "object" && typeof ns.codingcontract.getContractType === "function") {
                                data.type = ns.codingcontract.getContractType(c, host) || "";
                            }
                        } catch (_) {}
                        // write to JSON file (append)
                        let existing = [];
                        try {
                            const raw = ns.read(OUTPUT);
                            existing = raw ? JSON.parse(raw) : [];
                        } catch (e) { existing = []; }
                        // dedupe
                        if (!existing.some(x => x.server === data.server && x.file === data.file)) {
                            existing.push(data);
                            ns.write(OUTPUT, JSON.stringify(existing, null, 2), "w");
                            ns.tprint(`contract-runner: logged ${c} on ${host} -> ${OUTPUT}`);
                        }
                    }
                } catch (e) {
                    ns.tprint("contract-runner item error: " + String(e));
                }
            }
            await ns.sleep(60000);
        } catch (e) {
            ns.tprint("contract-runner error: " + String(e));
            await ns.sleep(60000);
        }
    }
}
