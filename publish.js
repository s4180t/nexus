import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Nexus NPM registry URL.
 * @type {string}
 */
const NEXUS_NPM_REGISTRY_URL = "http://localhost:8081/repository/npm-hosted/";
/**
 * Maximum number of concurrent publish requests.
 * @type {number}
 */
const MAXIMUM_CONCURRENT_REQUESTS = 8;

/**
 * The absolute path of the current file.
 * @type {string}
 */
const __filename = fileURLToPath(import.meta.url);
/**
 * The absolute directory name of the current file.
 * @type {string}
 */
const __dirname = path.dirname(__filename);

// --- Utility Functions---
/**
 * Log an informational message with timestamp.
 * @param {string} message
 * @returns {void}
 */
function logInfo(message) {
    console.log(`[INFO ${new Date().toISOString()}] ${message}`);
}
/**
 * Log a warning message with timestamp.
 * @param {string} message
 * @returns {void}
 */
function logWarn(message) {
    console.log(`[WARN ${new Date().toISOString()}] ${message}`);
}
/**
 * Log an error message with timestamp.
 * @param {string} message
 * @returns {void}
 */
function logError(message) {
    console.log(`[ERROR ${new Date().toISOString()}] ${message}`);
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<() => Promise<any>>} tasks - Array of async functions returning promises.
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
 * Publish tarballs to the npm registry.
 * @param {Array<string>} tarballs - Array of tarball file paths to publish.
 * @returns {Promise<Array>} - Results of publish attempts.
 */
export async function publishTarballs(tarballs) {
    const publishTasks = tarballs.map((tarball) => async () => {
        logInfo(`Publishing ${tarball}...`);
        return new Promise((resolve, reject) => {
            exec(
                `npm publish ${tarball} --registry ${NEXUS_NPM_REGISTRY_URL} --provenance=false --loglevel=error`,
                (error, stdout, stderr) => {
                    if (error) {
                        logError(`Error publishing ${tarball}: ${stderr}`);
                        reject(error);
                    } else {
                        logInfo(`Published ${tarball}: ${stdout}`);
                        resolve(stdout);
                    }
                }
            );
        });
    });
    return runWithConcurrencyLimit(publishTasks, MAXIMUM_CONCURRENT_REQUESTS);
}

// --- Main Entrypoint ---
/**
 * Main function to find and publish tarballs from the archives directory.
 * Exits with code 0 on success, 1 on failure.
 * @returns {Promise<void>}
 */
async function main() {
    // get tarballs from archives directory
    const tarballs = [];
    const archivesDir = path.join(__dirname, "archives");

    const files = fs.readdirSync(archivesDir);
    for (const file of files) {
        tarballs.push(path.join(archivesDir, file));
    }

    logInfo(`Found ${tarballs.length} tarballs to publish.`);
    logInfo("Starting to publish tarballs...");

    const results = await publishTarballs(tarballs);
    logInfo("All tarballs processed.");
    process.exit(0);
}

// Run the main function and handle any unhandled errors
main().catch((error) => {
    logError(`Unhandled error: ${error.stack || error}`);
    process.exit(1);
});
