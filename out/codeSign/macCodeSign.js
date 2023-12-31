"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findIdentity = exports.findIdentityRawResult = exports.sign = exports.createKeychain = exports.removeKeychain = exports.reportError = exports.isSignAllowed = exports.appleCertificatePrefixes = void 0;
const bluebird_lst_1 = require("bluebird-lst");
const util_1 = require("builder-util/out/util");
const fs_1 = require("builder-util/out/fs");
const log_1 = require("builder-util/out/log");
const crypto_1 = require("crypto");
const promises_1 = require("fs/promises");
const lazy_val_1 = require("lazy-val");
const os_1 = require("os");
const path = require("path");
const temp_file_1 = require("temp-file");
const flags_1 = require("../util/flags");
const codesign_1 = require("./codesign");
const util_identities_1 = require("@electron/osx-sign/dist/cjs/util-identities");
exports.appleCertificatePrefixes = ["Developer ID Application:", "Developer ID Installer:", "3rd Party Mac Developer Application:", "3rd Party Mac Developer Installer:"];
function isSignAllowed(isPrintWarn = true) {
    if (process.platform !== "darwin") {
        if (isPrintWarn) {
            util_1.log.warn({ reason: "supported only on macOS" }, "skipped macOS application code signing");
        }
        return false;
    }
    const buildForPrWarning = "There are serious security concerns with CSC_FOR_PULL_REQUEST=true (see the  CircleCI documentation (https://circleci.com/docs/1.0/fork-pr-builds/) for details)" +
        "\nIf you have SSH keys, sensitive env vars or AWS credentials stored in your project settings and untrusted forks can make pull requests against your repo, then this option isn't for you.";
    if ((0, util_1.isPullRequest)()) {
        if ((0, util_1.isEnvTrue)(process.env.CSC_FOR_PULL_REQUEST)) {
            if (isPrintWarn) {
                util_1.log.warn(buildForPrWarning);
            }
        }
        else {
            if (isPrintWarn) {
                // https://github.com/electron-userland/electron-builder/issues/1524
                util_1.log.warn("Current build is a part of pull request, code signing will be skipped." + "\nSet env CSC_FOR_PULL_REQUEST to true to force code signing." + `\n${buildForPrWarning}`);
            }
            return false;
        }
    }
    return true;
}
exports.isSignAllowed = isSignAllowed;
async function reportError(isMas, certificateTypes, qualifier, keychainFile, isForceCodeSigning) {
    const logFields = {};
    if (qualifier == null) {
        logFields.reason = "";
        if ((0, flags_1.isAutoDiscoveryCodeSignIdentity)()) {
            logFields.reason += `cannot find valid "${certificateTypes.join(", ")}" identity${isMas ? "" : ` or custom non-Apple code signing certificate, it could cause some undefined behaviour, e.g. macOS localized description not visible`}`;
        }
        logFields.reason += ", see https://electron.build/code-signing";
        if (!(0, flags_1.isAutoDiscoveryCodeSignIdentity)()) {
            logFields.CSC_IDENTITY_AUTO_DISCOVERY = false;
        }
    }
    else {
        logFields.reason = "Identity name is specified, but no valid identity with this name in the keychain";
        logFields.identity = qualifier;
    }
    const args = ["find-identity"];
    if (keychainFile != null) {
        args.push(keychainFile);
    }
    if (qualifier != null || (0, flags_1.isAutoDiscoveryCodeSignIdentity)()) {
        logFields.allIdentities = (await (0, util_1.exec)("security", args))
            .trim()
            .split("\n")
            .filter(it => !(it.includes("Policy: X.509 Basic") || it.includes("Matching identities")))
            .join("\n");
    }
    if (isMas || isForceCodeSigning) {
        throw new Error(log_1.Logger.createMessage("skipped macOS application code signing", logFields, "error", it => it));
    }
    else {
        util_1.log.warn(logFields, "skipped macOS application code signing");
    }
}
exports.reportError = reportError;
// "Note that filename will not be searched to resolve the signing identity's certificate chain unless it is also on the user's keychain search list."
// but "security list-keychains" doesn't support add - we should 1) get current list 2) set new list - it is very bad http://stackoverflow.com/questions/10538942/add-a-keychain-to-search-list
// "overly complicated and introduces a race condition."
// https://github.com/electron-userland/electron-builder/issues/398
const bundledCertKeychainAdded = new lazy_val_1.Lazy(async () => {
    // copy to temp and then atomic rename to final path
    const cacheDir = getCacheDirectory();
    const tmpKeychainPath = path.join(cacheDir, (0, temp_file_1.getTempName)("electron-builder-root-certs"));
    const keychainPath = path.join(cacheDir, "electron-builder-root-certs.keychain");
    const results = await Promise.all([
        listUserKeychains(),
        (0, fs_1.copyFile)(path.join(__dirname, "..", "..", "certs", "root_certs.keychain"), tmpKeychainPath).then(() => (0, promises_1.rename)(tmpKeychainPath, keychainPath)),
    ]);
    const list = results[0];
    if (!list.includes(keychainPath)) {
        await (0, util_1.exec)("security", ["list-keychains", "-d", "user", "-s", keychainPath].concat(list));
    }
});
function getCacheDirectory() {
    const env = process.env.ELECTRON_BUILDER_CACHE;
    return (0, util_1.isEmptyOrSpaces)(env) ? path.join((0, os_1.homedir)(), "Library", "Caches", "electron-builder") : path.resolve(env);
}
function listUserKeychains() {
    return (0, util_1.exec)("security", ["list-keychains", "-d", "user"]).then(it => it
        .split("\n")
        .map(it => {
        const r = it.trim();
        return r.substring(1, r.length - 1);
    })
        .filter(it => it.length > 0));
}
function removeKeychain(keychainFile, printWarn = true) {
    return (0, util_1.exec)("security", ["delete-keychain", keychainFile]).catch((e) => {
        if (printWarn) {
            util_1.log.warn({ file: keychainFile, error: e.stack || e }, "cannot delete keychain");
        }
        return (0, fs_1.unlinkIfExists)(keychainFile);
    });
}
exports.removeKeychain = removeKeychain;
async function createKeychain({ tmpDir, cscLink, cscKeyPassword, cscILink, cscIKeyPassword, currentDir }) {
    // travis has correct AppleWWDRCA cert
    if (process.env.TRAVIS !== "true") {
        await bundledCertKeychainAdded.value;
    }
    // https://github.com/electron-userland/electron-builder/issues/3685
    // use constant file
    const keychainFile = path.join(process.env.APP_BUILDER_TMP_DIR || (0, os_1.tmpdir)(), `${(0, crypto_1.createHash)("sha256").update(currentDir).update("app-builder").digest("hex")}.keychain`);
    // noinspection JSUnusedLocalSymbols
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    await removeKeychain(keychainFile, false).catch(_ => {
        /* ignore*/
    });
    const certLinks = [cscLink];
    if (cscILink != null) {
        certLinks.push(cscILink);
    }
    const certPaths = new Array(certLinks.length);
    const keychainPassword = (0, crypto_1.randomBytes)(32).toString("base64");
    const securityCommands = [
        ["create-keychain", "-p", keychainPassword, keychainFile],
        ["unlock-keychain", "-p", keychainPassword, keychainFile],
        ["set-keychain-settings", keychainFile],
    ];
    // https://stackoverflow.com/questions/42484678/codesign-keychain-gets-ignored
    // https://github.com/electron-userland/electron-builder/issues/1457
    const list = await listUserKeychains();
    if (!list.includes(keychainFile)) {
        securityCommands.push(["list-keychains", "-d", "user", "-s", keychainFile].concat(list));
    }
    await Promise.all([
        // we do not clear downloaded files - will be removed on tmpDir cleanup automatically. not a security issue since in any case data is available as env variables and protected by password.
        bluebird_lst_1.default.map(certLinks, (link, i) => (0, codesign_1.importCertificate)(link, tmpDir, currentDir).then(it => (certPaths[i] = it))),
        bluebird_lst_1.default.mapSeries(securityCommands, it => (0, util_1.exec)("security", it)),
    ]);
    return await importCerts(keychainFile, certPaths, [cscKeyPassword, cscIKeyPassword].filter(it => it != null));
}
exports.createKeychain = createKeychain;
async function importCerts(keychainFile, paths, keyPasswords) {
    for (let i = 0; i < paths.length; i++) {
        const password = keyPasswords[i];
        await (0, util_1.exec)("security", ["import", paths[i], "-k", keychainFile, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-P", password]);
        // https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
        // https://github.com/electron-userland/electron-packager/issues/701#issuecomment-322315996
        await (0, util_1.exec)("security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
    }
    return {
        keychainFile,
    };
}
/** @private */
function sign(path, name, keychain) {
    const args = ["--deep", "--force", "--sign", name, path];
    if (keychain != null) {
        args.push("--keychain", keychain);
    }
    return (0, util_1.exec)("codesign", args);
}
exports.sign = sign;
exports.findIdentityRawResult = null;
async function getValidIdentities(keychain) {
    function addKeychain(args) {
        if (keychain != null) {
            args.push(keychain);
        }
        return args;
    }
    let result = exports.findIdentityRawResult;
    if (result == null || keychain != null) {
        // https://github.com/electron-userland/electron-builder/issues/481
        // https://github.com/electron-userland/electron-builder/issues/535
        result = Promise.all([
            (0, util_1.exec)("security", addKeychain(["find-identity", "-v"])).then(it => it
                .trim()
                .split("\n")
                .filter(it => {
                for (const prefix of exports.appleCertificatePrefixes) {
                    if (it.includes(prefix)) {
                        return true;
                    }
                }
                return false;
            })),
            (0, util_1.exec)("security", addKeychain(["find-identity", "-v", "-p", "codesigning"])).then(it => it.trim().split("\n")),
        ]).then(it => {
            const array = it[0]
                .concat(it[1])
                .filter(it => !it.includes("(Missing required extension)") && !it.includes("valid identities found") && !it.includes("iPhone ") && !it.includes("com.apple.idms.appleid.prd."))
                // remove 1)
                .map(it => it.substring(it.indexOf(")") + 1).trim());
            return Array.from(new Set(array));
        });
        if (keychain == null) {
            exports.findIdentityRawResult = result;
        }
    }
    return result;
}
async function _findIdentity(type, qualifier, keychain) {
    // https://github.com/electron-userland/electron-builder/issues/484
    //noinspection SpellCheckingInspection
    const lines = await getValidIdentities(keychain);
    const namePrefix = `${type}:`;
    for (const line of lines) {
        if (qualifier != null && !line.includes(qualifier)) {
            continue;
        }
        if (line.includes(namePrefix)) {
            return parseIdentity(line);
        }
    }
    if (type === "Developer ID Application") {
        // find non-Apple certificate
        // https://github.com/electron-userland/electron-builder/issues/458
        l: for (const line of lines) {
            if (qualifier != null && !line.includes(qualifier)) {
                continue;
            }
            if (line.includes("Mac Developer:")) {
                continue;
            }
            for (const prefix of exports.appleCertificatePrefixes) {
                if (line.includes(prefix)) {
                    continue l;
                }
            }
            return parseIdentity(line);
        }
    }
    return null;
}
function parseIdentity(line) {
    const firstQuoteIndex = line.indexOf('"');
    const name = line.substring(firstQuoteIndex + 1, line.lastIndexOf('"'));
    const hash = line.substring(0, firstQuoteIndex - 1);
    return new util_identities_1.Identity(name, hash);
}
function findIdentity(certType, qualifier, keychain) {
    let identity = qualifier || process.env.CSC_NAME;
    if ((0, util_1.isEmptyOrSpaces)(identity)) {
        if ((0, flags_1.isAutoDiscoveryCodeSignIdentity)()) {
            return _findIdentity(certType, null, keychain);
        }
        else {
            return Promise.resolve(null);
        }
    }
    else {
        identity = identity.trim();
        for (const prefix of exports.appleCertificatePrefixes) {
            checkPrefix(identity, prefix);
        }
        return _findIdentity(certType, identity, keychain);
    }
}
exports.findIdentity = findIdentity;
function checkPrefix(name, prefix) {
    if (name.startsWith(prefix)) {
        throw new util_1.InvalidConfigurationError(`Please remove prefix "${prefix}" from the specified name — appropriate certificate will be chosen automatically`);
    }
}
//# sourceMappingURL=macCodeSign.js.map