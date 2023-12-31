"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importCertificate = void 0;
const fs_extra_1 = require("fs-extra");
const os_1 = require("os");
const path = require("path");
const builder_util_1 = require("builder-util");
const fs_1 = require("builder-util/out/fs");
const binDownload_1 = require("../binDownload");
/** @private */
async function importCertificate(cscLink, tmpDir, currentDir) {
    var _a, _b;
    cscLink = cscLink.trim();
    let file = null;
    if ((cscLink.length > 3 && cscLink[1] === ":") || cscLink.startsWith("/") || cscLink.startsWith(".")) {
        file = cscLink;
    }
    else if (cscLink.startsWith("file://")) {
        file = cscLink.substring("file://".length);
    }
    else if (cscLink.startsWith("~/")) {
        file = path.join((0, os_1.homedir)(), cscLink.substring("~/".length));
    }
    else if (cscLink.startsWith("https://")) {
        const tempFile = await tmpDir.getTempFile({ suffix: ".p12" });
        await (0, binDownload_1.download)(cscLink, tempFile);
        return tempFile;
    }
    else {
        const mimeType = (_a = /data:.*;base64,/.exec(cscLink)) === null || _a === void 0 ? void 0 : _a[0];
        if (mimeType || cscLink.length > 2048 || cscLink.endsWith("=")) {
            const tempFile = await tmpDir.getTempFile({ suffix: ".p12" });
            await (0, fs_extra_1.outputFile)(tempFile, Buffer.from(cscLink.substring((_b = mimeType === null || mimeType === void 0 ? void 0 : mimeType.length) !== null && _b !== void 0 ? _b : 0), "base64"));
            return tempFile;
        }
        file = cscLink;
    }
    file = path.resolve(currentDir, file);
    const stat = await (0, fs_1.statOrNull)(file);
    if (stat == null) {
        throw new builder_util_1.InvalidConfigurationError(`${file} doesn't exist`);
    }
    else if (!stat.isFile()) {
        throw new builder_util_1.InvalidConfigurationError(`${file} not a file`);
    }
    else {
        return file;
    }
}
exports.importCertificate = importCertificate;
//# sourceMappingURL=codesign.js.map