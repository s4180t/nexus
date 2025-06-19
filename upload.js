import { rename, mkdir, stat, writeFile } from "node:fs/promises";
import { exec, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NEXUS_NPM_REGISTRY_URL = "http://localhost:8081/repository/npm-hosted/";
const MAXIMUM_CONCURRENT_REQUESTS = 10;

// --- Utility Functions ---
/**
 * Log an informational message with timestamp.
 * @param {string} message
 */
function logInfo(message) {
    console.log(`[INFO ${new Date().toISOString()}] ${message}`);
}
/**
 * Log a warning message with timestamp.
 * @param {string} message
 */
function logWarn(message) {
    console.log(`[WARN ${new Date().toISOString()}] ${message}`);
}
/**
 * Log an error message with timestamp.
 * @param {string} message
 */
function logError(message) {
    console.log(`[ERROR ${new Date().toISOString()}] ${message}`);
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<Function>} tasks - Array of async functions returning promises.
 * @param {number} limit - Maximum number of concurrent tasks.
 * @returns {Promise<Array>} - Resolves with an array of results.
 */
async function runWithConcurrencyLimit(tasks, limit) {
    const results = [];
    let running = 0;
    let i = 0;
    return new Promise((resolve) => {
        function runNext() {
            if (i === tasks.length && running === 0) {
                resolve(results);
                return;
            }
            while (running < limit && i < tasks.length) {
                const currentIndex = i++;
                running++;
                tasks[currentIndex]()
                    .then((result) => (results[currentIndex] = result))
                    .catch((err) => (results[currentIndex] = err))
                    .finally(() => {
                        running--;
                        runNext();
                    });
            }
        }
        runNext();
    });
}

// --- Core Logic ---
/**
 * Recursively fetches tarballs for all npm dependencies.
 * @param {Object} deps - The npm dependencies object.
 * @returns {Promise<Array<{tarball: string, name: string, version: string}>>}
 */
async function getTarBalls(deps) {
    logInfo("Starting tarball collection...");
    const tarBalls = [];
    const packages = deps.dependencies || deps;
    try {
        await stat("./archives");
    } catch (_) {
        await mkdir("./archives");
        logInfo("Created ./archives directory");
    }
    const tasks = Object.entries(packages).map(([name, object]) => async () => {
        const fileName = `${name.replace(/@/g, "").replace(/\//g, "-")}-${object.version}.tgz`;
        const archivePath = `./archives/${fileName}`;
        try {
            await stat(archivePath);
            logInfo(`Archive exists: ${archivePath} for ${name}@${object.version}`);
            tarBalls.push({ tarball: archivePath, name, version: object.version });
        } catch (_) {
            await createTarball(name, object, tarBalls);
        }
        if (object.dependencies) {
            const childTarBalls = await getTarBalls(object.dependencies);
            tarBalls.push(...childTarBalls);
        }
    });
    await runWithConcurrencyLimit(tasks, MAXIMUM_CONCURRENT_REQUESTS);
    logInfo("Finished tarball collection.");
    return tarBalls;
}

/**
 * Create a tarball for a given npm package.
 * @param {string} name - Package name.
 * @param {Object} object - Package metadata object.
 * @param {Array} tarBalls - Array to collect tarball info objects.
 * @returns {Promise<void>}
 */
async function createTarball(name, object, tarBalls) {
    logInfo(`Creating archive for ${name}@${object.version}`);
    const tarball = await new Promise((resolve, reject) => {
        const url = object.resolved;
        if (!url) {
            logWarn(`No resolved URL for ${name}@${object.version}, using npm pack.`);
            let pkgName = object.version ? `${name}@${object.version}` : name;
            exec(`npm pack ${pkgName}`, (error, stdout, stderr) => {
                if (error) {
                    logError(`Error creating tarball for ${name}@${object.version}: ${stderr}`);
                    reject(`Error creating tarball: ${stderr}`);
                } else {
                    resolve(stdout.trim());
                }
            });
            return;
        }
        logInfo(`Fetching tarball from ${url} for ${name}@${object.version}`);
        fetch(url)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch tarball: ${response.statusText}`);
                }
                return response.arrayBuffer();
            })
            .then((buffer) => {
                const nodeBuffer = Buffer.from(buffer);
                const fileName = `${name.replace(/@/g, "").replace(/\//g, "-")}-${object.version}.tgz`;
                const filePath = `./archives/${fileName}`;
                return writeFile(filePath, nodeBuffer).then(() => fileName);
            })
            .then(resolve)
            .catch((err) => {
                logError(`Failed to fetch/write tarball for ${name}@${object.version}: ${err}`);
                reject(err);
            });
    });
    const archiveFilePath = `./archives/${tarball}`;
    const existingStat = await stat(archiveFilePath).catch(() => null);
    if (existingStat) {
        logInfo(`Tarball already exists: ${archiveFilePath} for ${name}@${object.version}`);
        return;
    }
    try {
        await rename(tarball, archiveFilePath);
    } catch (error) {
        if (error.code !== "EXDEV") {
            logError(`Error moving tarball for ${name}@${object.version}: ${error.message}`);
            throw error;
        }
    }
    tarBalls.push({ tarball: archiveFilePath, name, version: object.version });
    logInfo(`Created tarball: ${archiveFilePath} for ${name}@${object.version}`);
}

/**
 * Publish tarballs to the npm registry.
 * @param {Array<{tarball: string, name: string, version: string}>} tarballs
 * @returns {Promise<Array>} - Results of publish attempts.
 */
async function publishTarballs(tarballs) {
    const publishTasks = tarballs.map(({ tarball, name, version }) => async () => {
        const alreadyPublished = await new Promise((resolve) => {
            exec(`npm view ${name}@${version} --registry ${NEXUS_NPM_REGISTRY_URL}`, (error) => {
                resolve(!error);
            });
        });
        if (alreadyPublished) {
            logInfo(`Tarball already published: ${tarball} (${name}@${version})`);
            return `Tarball already published: ${tarball}`;
        }
        logInfo(`Publishing ${tarball} (${name}@${version})...`);
        return new Promise((resolve, reject) => {
            exec(
                `npm publish ${tarball} --registry ${NEXUS_NPM_REGISTRY_URL} --provenance=false --loglevel=error`,
                (error, stdout, stderr) => {
                    if (error) {
                        logError(`Error publishing ${tarball} (${name}@${version}): ${stderr}`);
                        reject(error);
                    } else {
                        logInfo(`Published ${tarball} (${name}@${version}): ${stdout}`);
                        resolve(stdout);
                    }
                }
            );
        });
    });
    return runWithConcurrencyLimit(publishTasks, MAXIMUM_CONCURRENT_REQUESTS);
}

// --- Main Orchestration ---
/**
 * Main workflow for collecting and publishing npm tarballs.
 * @returns {Promise<void>}
 */
async function main() {
    logInfo("--- NPM Tarball Upload Script Started ---");
    // read npm dependencies from npm ls --json --all
    const npmDependencies = JSON.parse(execSync("npm ls --json --all").toString());
    const tarBalls = await getTarBalls(npmDependencies.dependencies);
    const tarballsSortedAndFiltered = tarBalls
        .reduce((acc, entry) => {
            if (!acc.some((e) => e.tarball === entry.tarball)) {
                acc.push(entry);
            }
            return acc;
        }, [])
        .sort((a, b) => a.tarball.localeCompare(b.tarball));
    logInfo(`Tarballs created: ${tarballsSortedAndFiltered.length}`);
    const publishResults = await publishTarballs(tarballsSortedAndFiltered);
    logInfo("--- NPM Tarball Upload Script Finished ---");
    // Remove all remaining .tgz files from current directory
    const files = await fs.readdirSync(".");
    const tgzFiles = files.filter((f) => f.endsWith(".tgz"));
    for (const file of tgzFiles) {
        fs.unlinkSync(path.join(".", file));
        logInfo(`Removed file: ${file}`);
    }
}

// --- Run Main ---
main().catch((err) => {
    logError(`Fatal error: ${err}`);
    process.exit(1);
});
