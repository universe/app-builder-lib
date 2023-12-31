"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NsisTarget = void 0;
const _7zip_bin_1 = require("7zip-bin");
const bluebird_lst_1 = require("bluebird-lst");
const builder_util_1 = require("builder-util");
const builder_util_runtime_1 = require("builder-util-runtime");
const fs_1 = require("builder-util/out/fs");
const debug_1 = require("debug");
const fs = require("fs");
const fs_extra_1 = require("fs-extra");
const path = require("path");
const binDownload_1 = require("../../binDownload");
const core_1 = require("../../core");
const CommonWindowsInstallerConfiguration_1 = require("../../options/CommonWindowsInstallerConfiguration");
const platformPackager_1 = require("../../platformPackager");
const hash_1 = require("../../util/hash");
const macosVersion_1 = require("../../util/macosVersion");
const timer_1 = require("../../util/timer");
const wine_1 = require("../../wine");
const archive_1 = require("../archive");
const differentialUpdateInfoBuilder_1 = require("../differentialUpdateInfoBuilder");
const targetUtil_1 = require("../targetUtil");
const nsisLang_1 = require("./nsisLang");
const nsisLicense_1 = require("./nsisLicense");
const nsisScriptGenerator_1 = require("./nsisScriptGenerator");
const nsisUtil_1 = require("./nsisUtil");
const debug = (0, debug_1.default)("electron-builder:nsis");
// noinspection SpellCheckingInspection
const ELECTRON_BUILDER_NS_UUID = builder_util_runtime_1.UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3");
// noinspection SpellCheckingInspection
const nsisResourcePathPromise = () => (0, binDownload_1.getBinFromUrl)("nsis-resources", "3.4.1", "Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==");
const USE_NSIS_BUILT_IN_COMPRESSOR = false;
class NsisTarget extends core_1.Target {
    constructor(packager, outDir, targetName, packageHelper) {
        super(targetName);
        this.packager = packager;
        this.outDir = outDir;
        this.packageHelper = packageHelper;
        /** @private */
        this.archs = new Map();
        this.packageHelper.refCount++;
        this.options =
            targetName === "portable"
                ? Object.create(null)
                : {
                    preCompressedFileExtensions: [".avi", ".mov", ".m4v", ".mp4", ".m4p", ".qt", ".mkv", ".webm", ".vmdk"],
                    ...this.packager.config.nsis,
                };
        if (targetName !== "nsis") {
            Object.assign(this.options, this.packager.config[targetName === "nsis-web" ? "nsisWeb" : targetName]);
        }
        const deps = packager.info.metadata.dependencies;
        if (deps != null && deps["electron-squirrel-startup"] != null) {
            builder_util_1.log.warn('"electron-squirrel-startup" dependency is not required for NSIS');
        }
        nsisUtil_1.NsisTargetOptions.resolve(this.options);
    }
    build(appOutDir, arch) {
        this.archs.set(arch, appOutDir);
        return Promise.resolve();
    }
    get isBuildDifferentialAware() {
        return !this.isPortable && this.options.differentialPackage !== false;
    }
    getPreCompressedFileExtensions() {
        const result = this.isWebInstaller ? null : this.options.preCompressedFileExtensions;
        return result == null ? null : (0, builder_util_1.asArray)(result).map(it => (it.startsWith(".") ? it : `.${it}`));
    }
    /** @private */
    async buildAppPackage(appOutDir, arch) {
        const options = this.options;
        const packager = this.packager;
        const isBuildDifferentialAware = this.isBuildDifferentialAware;
        const format = !isBuildDifferentialAware && options.useZip ? "zip" : "7z";
        const archiveFile = path.join(this.outDir, `${packager.appInfo.sanitizedName}-${packager.appInfo.version}-${builder_util_1.Arch[arch]}.nsis.${format}`);
        const preCompressedFileExtensions = this.getPreCompressedFileExtensions();
        const archiveOptions = {
            withoutDir: true,
            compression: packager.compression,
            excluded: preCompressedFileExtensions == null ? null : preCompressedFileExtensions.map(it => `*${it}`),
        };
        const timer = (0, timer_1.time)(`nsis package, ${builder_util_1.Arch[arch]}`);
        await (0, archive_1.archive)(format, archiveFile, appOutDir, isBuildDifferentialAware ? (0, differentialUpdateInfoBuilder_1.configureDifferentialAwareArchiveOptions)(archiveOptions) : archiveOptions);
        timer.end();
        if (isBuildDifferentialAware && this.isWebInstaller) {
            const data = await (0, differentialUpdateInfoBuilder_1.appendBlockmap)(archiveFile);
            return {
                ...data,
                path: archiveFile,
            };
        }
        else {
            return await createPackageFileInfo(archiveFile);
        }
    }
    get installerFilenamePattern() {
        // tslint:disable:no-invalid-template-strings
        return "${productName} " + (this.isPortable ? "" : "Setup ") + "${version}.${ext}";
    }
    get isPortable() {
        return this.name === "portable";
    }
    async finishBuild() {
        try {
            const { pattern } = this.packager.artifactPatternConfig(this.options, this.installerFilenamePattern);
            const builds = new Set([this.archs]);
            if (pattern.includes("${arch}") && this.archs.size > 1) {
                ;
                [...this.archs].forEach(([arch, appOutDir]) => builds.add(new Map().set(arch, appOutDir)));
            }
            const doBuildArchs = builds.values();
            for (const archs of doBuildArchs) {
                await this.buildInstaller(archs);
            }
        }
        finally {
            await this.packageHelper.finishBuild();
        }
    }
    async buildInstaller(archs) {
        var _a;
        const primaryArch = archs.size === 1 ? archs.keys().next().value : null;
        const packager = this.packager;
        const appInfo = packager.appInfo;
        const options = this.options;
        const installerFilename = packager.expandArtifactNamePattern(options, "exe", primaryArch, this.installerFilenamePattern, false, this.packager.platformSpecificBuildOptions.defaultArch);
        const oneClick = options.oneClick !== false;
        const installerPath = path.join(this.outDir, installerFilename);
        const logFields = {
            target: this.name,
            file: builder_util_1.log.filePath(installerPath),
            archs: Array.from(archs.keys())
                .map(it => builder_util_1.Arch[it])
                .join(", "),
        };
        const isPerMachine = options.perMachine === true;
        if (!this.isPortable) {
            logFields.oneClick = oneClick;
            logFields.perMachine = isPerMachine;
        }
        await packager.info.callArtifactBuildStarted({
            targetPresentableName: this.name,
            file: installerPath,
            arch: primaryArch,
        }, logFields);
        const guid = options.guid || builder_util_runtime_1.UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID);
        const uninstallAppKey = guid.replace(/\\/g, " - ");
        const defines = {
            APP_ID: appInfo.id,
            APP_GUID: guid,
            // Windows bug - entry in Software\Microsoft\Windows\CurrentVersion\Uninstall cannot have \ symbols (dir)
            UNINSTALL_APP_KEY: uninstallAppKey,
            PRODUCT_NAME: appInfo.productName,
            PRODUCT_FILENAME: appInfo.productFilename,
            APP_FILENAME: (0, targetUtil_1.getWindowsInstallationDirName)(appInfo, !oneClick || isPerMachine),
            APP_DESCRIPTION: appInfo.description,
            VERSION: appInfo.version,
            PROJECT_DIR: packager.projectDir,
            BUILD_RESOURCES_DIR: packager.info.buildResourcesDir,
            APP_PACKAGE_NAME: (0, targetUtil_1.getWindowsInstallationAppPackageName)(appInfo.name),
        };
        if ((_a = options.customNsisBinary) === null || _a === void 0 ? void 0 : _a.debugLogging) {
            defines.ENABLE_LOGGING_ELECTRON_BUILDER = null;
        }
        if (uninstallAppKey !== guid) {
            defines.UNINSTALL_REGISTRY_KEY_2 = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`;
        }
        const commands = {
            OutFile: `"${installerPath}"`,
            VIProductVersion: appInfo.getVersionInWeirdWindowsForm(),
            VIAddVersionKey: this.computeVersionKey(),
            Unicode: this.isUnicodeEnabled,
        };
        const isPortable = this.isPortable;
        const iconPath = (isPortable ? null : await packager.getResource(options.installerIcon, "installerIcon.ico")) || (await packager.getIconPath());
        if (iconPath != null) {
            if (isPortable) {
                commands.Icon = `"${iconPath}"`;
            }
            else {
                defines.MUI_ICON = iconPath;
                defines.MUI_UNICON = iconPath;
            }
        }
        const packageFiles = {};
        let estimatedSize = 0;
        if (this.isPortable && options.useZip) {
            for (const [arch, dir] of archs.entries()) {
                defines[arch === builder_util_1.Arch.x64 ? "APP_DIR_64" : arch === builder_util_1.Arch.arm64 ? "APP_DIR_ARM64" : "APP_DIR_32"] = dir;
            }
        }
        else if (USE_NSIS_BUILT_IN_COMPRESSOR && archs.size === 1) {
            defines.APP_BUILD_DIR = archs.get(archs.keys().next().value);
        }
        else {
            await bluebird_lst_1.default.map(archs.keys(), async (arch) => {
                const { fileInfo, unpackedSize } = await this.packageHelper.packArch(arch, this);
                const file = fileInfo.path;
                const defineKey = arch === builder_util_1.Arch.x64 ? "APP_64" : arch === builder_util_1.Arch.arm64 ? "APP_ARM64" : "APP_32";
                defines[defineKey] = file;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                const defineNameKey = `${defineKey}_NAME`;
                defines[defineNameKey] = path.basename(file);
                // nsis expect a hexadecimal string
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                const defineHashKey = `${defineKey}_HASH`;
                defines[defineHashKey] = Buffer.from(fileInfo.sha512, "base64").toString("hex").toUpperCase();
                // NSIS accepts size in KiloBytes and supports only whole numbers
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                const defineUnpackedSizeKey = `${defineKey}_UNPACKED_SIZE`;
                defines[defineUnpackedSizeKey] = Math.ceil(unpackedSize / 1024).toString();
                if (this.isWebInstaller) {
                    await packager.dispatchArtifactCreated(file, this, arch);
                    packageFiles[builder_util_1.Arch[arch]] = fileInfo;
                }
                const archiveInfo = (await (0, builder_util_1.exec)(_7zip_bin_1.path7za, ["l", file])).trim();
                // after adding blockmap data will be "Warnings: 1" in the end of output
                const match = /(\d+)\s+\d+\s+\d+\s+files/.exec(archiveInfo);
                if (match == null) {
                    builder_util_1.log.warn({ output: archiveInfo }, "cannot compute size of app package");
                }
                else {
                    estimatedSize += parseInt(match[1], 10);
                }
            });
        }
        this.configureDefinesForAllTypeOfInstaller(defines);
        if (isPortable) {
            const { unpackDirName, requestExecutionLevel, splashImage } = options;
            defines.REQUEST_EXECUTION_LEVEL = requestExecutionLevel || "user";
            // https://github.com/electron-userland/electron-builder/issues/5764
            if (typeof unpackDirName === "string" || !unpackDirName) {
                defines.UNPACK_DIR_NAME = unpackDirName || (await (0, builder_util_1.executeAppBuilder)(["ksuid"]));
            }
            if (splashImage != null) {
                defines.SPLASH_IMAGE = path.resolve(packager.projectDir, splashImage);
            }
        }
        else {
            await this.configureDefines(oneClick, defines);
        }
        if (estimatedSize !== 0) {
            // in kb
            defines.ESTIMATED_SIZE = Math.round(estimatedSize / 1024);
        }
        if (packager.compression === "store") {
            commands.SetCompress = "off";
        }
        else {
            // difference - 33.540 vs 33.601, only 61 KB (but zip is faster to decompress)
            // do not use /SOLID - "With solid compression, files are uncompressed to temporary file before they are copied to their final destination",
            // it is not good for portable installer (where built-in NSIS compression is used). http://forums.winamp.com/showpost.php?p=2982902&postcount=6
            commands.SetCompressor = "zlib";
            if (!this.isWebInstaller) {
                defines.COMPRESS = "auto";
            }
        }
        debug(defines);
        debug(commands);
        if (packager.packagerOptions.effectiveOptionComputed != null && (await packager.packagerOptions.effectiveOptionComputed([defines, commands]))) {
            return;
        }
        // prepare short-version variants of defines and commands, to make an uninstaller that doesn't differ much from the previous one
        const definesUninstaller = { ...defines };
        const commandsUninstaller = { ...commands };
        if (appInfo.shortVersion != null) {
            definesUninstaller.VERSION = appInfo.shortVersion;
            commandsUninstaller.VIProductVersion = appInfo.shortVersionWindows;
            commandsUninstaller.VIAddVersionKey = this.computeVersionKey(true);
        }
        const sharedHeader = await this.computeCommonInstallerScriptHeader();
        const script = isPortable
            ? await (0, fs_extra_1.readFile)(path.join(nsisUtil_1.nsisTemplatesDir, "portable.nsi"), "utf8")
            : await this.computeScriptAndSignUninstaller(definesUninstaller, commandsUninstaller, installerPath, sharedHeader, archs);
        // copy outfile name into main options, as the computeScriptAndSignUninstaller function was kind enough to add important data to temporary defines.
        defines.UNINSTALLER_OUT_FILE = definesUninstaller.UNINSTALLER_OUT_FILE;
        await this.executeMakensis(defines, commands, sharedHeader + (await this.computeFinalScript(script, true, archs)));
        await Promise.all([packager.sign(installerPath), defines.UNINSTALLER_OUT_FILE == null ? Promise.resolve() : (0, fs_extra_1.unlink)(defines.UNINSTALLER_OUT_FILE)]);
        const safeArtifactName = (0, platformPackager_1.computeSafeArtifactNameIfNeeded)(installerFilename, () => this.generateGitHubInstallerName());
        let updateInfo;
        if (this.isWebInstaller) {
            updateInfo = (0, differentialUpdateInfoBuilder_1.createNsisWebDifferentialUpdateInfo)(installerPath, packageFiles);
        }
        else if (this.isBuildDifferentialAware) {
            updateInfo = await (0, differentialUpdateInfoBuilder_1.createBlockmap)(installerPath, this, packager, safeArtifactName);
        }
        if (updateInfo != null && isPerMachine && (oneClick || options.packElevateHelper)) {
            updateInfo.isAdminRightsRequired = true;
        }
        await packager.info.callArtifactBuildCompleted({
            file: installerPath,
            updateInfo,
            target: this,
            packager,
            arch: primaryArch,
            safeArtifactName,
            isWriteUpdateInfo: !this.isPortable,
        });
    }
    generateGitHubInstallerName() {
        const appInfo = this.packager.appInfo;
        const classifier = appInfo.name.toLowerCase() === appInfo.name ? "setup-" : "Setup-";
        return `${appInfo.name}-${this.isPortable ? "" : classifier}${appInfo.version}.exe`;
    }
    get isUnicodeEnabled() {
        return this.options.unicode !== false;
    }
    get isWebInstaller() {
        return false;
    }
    async computeScriptAndSignUninstaller(defines, commands, installerPath, sharedHeader, archs) {
        const packager = this.packager;
        const customScriptPath = await packager.getResource(this.options.script, "installer.nsi");
        const script = await (0, fs_extra_1.readFile)(customScriptPath || path.join(nsisUtil_1.nsisTemplatesDir, "installer.nsi"), "utf8");
        if (customScriptPath != null) {
            builder_util_1.log.info({ reason: "custom NSIS script is used" }, "uninstaller is not signed by electron-builder");
            return script;
        }
        // https://github.com/electron-userland/electron-builder/issues/2103
        // it is more safe and reliable to write uninstaller to our out dir
        const uninstallerPath = path.join(this.outDir, `__uninstaller-${this.name}-${this.packager.appInfo.sanitizedName}.exe`);
        const isWin = process.platform === "win32";
        defines.BUILD_UNINSTALLER = null;
        defines.UNINSTALLER_OUT_FILE = isWin ? uninstallerPath : path.win32.join("Z:", uninstallerPath);
        await this.executeMakensis(defines, commands, sharedHeader + (await this.computeFinalScript(script, false, archs)));
        // http://forums.winamp.com/showthread.php?p=3078545
        if ((0, macosVersion_1.isMacOsCatalina)()) {
            try {
                await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
            }
            catch (error) {
                builder_util_1.log.warn(`packager.vm is used: ${error.message}`);
                const vm = await packager.vm.value;
                await vm.exec(installerPath, []);
                // Parallels VM can exit after command execution, but NSIS continue to be running
                let i = 0;
                while (!(await (0, fs_1.exists)(uninstallerPath)) && i++ < 100) {
                    // noinspection JSUnusedLocalSymbols
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    await new Promise((resolve, _reject) => setTimeout(resolve, 300));
                }
            }
        }
        else {
            await (0, wine_1.execWine)(installerPath, null, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
        }
        await packager.sign(uninstallerPath, "  Signing NSIS uninstaller");
        delete defines.BUILD_UNINSTALLER;
        // platform-specific path, not wine
        defines.UNINSTALLER_OUT_FILE = uninstallerPath;
        return script;
    }
    computeVersionKey(short = false) {
        // Error: invalid VIProductVersion format, should be X.X.X.X
        // so, we must strip beta
        const localeId = this.options.language || "1033";
        const appInfo = this.packager.appInfo;
        const versionKey = [
            `/LANG=${localeId} ProductName "${appInfo.productName}"`,
            `/LANG=${localeId} ProductVersion "${appInfo.version}"`,
            `/LANG=${localeId} LegalCopyright "${appInfo.copyright}"`,
            `/LANG=${localeId} FileDescription "${appInfo.description}"`,
            `/LANG=${localeId} FileVersion "${appInfo.buildVersion}"`,
        ];
        if (short) {
            versionKey[1] = `/LANG=${localeId} ProductVersion "${appInfo.shortVersion}"`;
            versionKey[4] = `/LANG=${localeId} FileVersion "${appInfo.shortVersion}"`;
        }
        (0, builder_util_1.use)(this.packager.platformSpecificBuildOptions.legalTrademarks, it => versionKey.push(`/LANG=${localeId} LegalTrademarks "${it}"`));
        (0, builder_util_1.use)(appInfo.companyName, it => versionKey.push(`/LANG=${localeId} CompanyName "${it}"`));
        return versionKey;
    }
    configureDefines(oneClick, defines) {
        const packager = this.packager;
        const options = this.options;
        const asyncTaskManager = new builder_util_1.AsyncTaskManager(packager.info.cancellationToken);
        if (oneClick) {
            defines.ONE_CLICK = null;
            if (options.runAfterFinish !== false) {
                defines.RUN_AFTER_FINISH = null;
            }
            asyncTaskManager.add(async () => {
                const installerHeaderIcon = await packager.getResource(options.installerHeaderIcon, "installerHeaderIcon.ico");
                if (installerHeaderIcon != null) {
                    defines.HEADER_ICO = installerHeaderIcon;
                }
            });
        }
        else {
            if (options.runAfterFinish === false) {
                defines.HIDE_RUN_AFTER_FINISH = null;
            }
            asyncTaskManager.add(async () => {
                const installerHeader = await packager.getResource(options.installerHeader, "installerHeader.bmp");
                if (installerHeader != null) {
                    defines.MUI_HEADERIMAGE = null;
                    defines.MUI_HEADERIMAGE_RIGHT = null;
                    defines.MUI_HEADERIMAGE_BITMAP = installerHeader;
                }
            });
            asyncTaskManager.add(async () => {
                const bitmap = (await packager.getResource(options.installerSidebar, "installerSidebar.bmp")) || "${NSISDIR}\\Contrib\\Graphics\\Wizard\\nsis3-metro.bmp";
                defines.MUI_WELCOMEFINISHPAGE_BITMAP = bitmap;
                defines.MUI_UNWELCOMEFINISHPAGE_BITMAP = (await packager.getResource(options.uninstallerSidebar, "uninstallerSidebar.bmp")) || bitmap;
            });
            if (options.allowElevation !== false) {
                defines.MULTIUSER_INSTALLMODE_ALLOW_ELEVATION = null;
            }
        }
        if (options.perMachine === true) {
            defines.INSTALL_MODE_PER_ALL_USERS = null;
        }
        if (!oneClick || options.perMachine === true) {
            defines.INSTALL_MODE_PER_ALL_USERS_REQUIRED = null;
        }
        if (options.allowToChangeInstallationDirectory) {
            if (oneClick) {
                throw new builder_util_1.InvalidConfigurationError("allowToChangeInstallationDirectory makes sense only for assisted installer (please set oneClick to false)");
            }
            defines.allowToChangeInstallationDirectory = null;
        }
        if (options.removeDefaultUninstallWelcomePage) {
            defines.removeDefaultUninstallWelcomePage = null;
        }
        const commonOptions = (0, CommonWindowsInstallerConfiguration_1.getEffectiveOptions)(options, packager);
        if (commonOptions.menuCategory != null) {
            defines.MENU_FILENAME = commonOptions.menuCategory;
        }
        defines.SHORTCUT_NAME = commonOptions.shortcutName;
        if (options.deleteAppDataOnUninstall) {
            defines.DELETE_APP_DATA_ON_UNINSTALL = null;
        }
        asyncTaskManager.add(async () => {
            const uninstallerIcon = await packager.getResource(options.uninstallerIcon, "uninstallerIcon.ico");
            if (uninstallerIcon != null) {
                // we don't need to copy MUI_UNICON (defaults to app icon), so, we have 2 defines
                defines.UNINSTALLER_ICON = uninstallerIcon;
                defines.MUI_UNICON = uninstallerIcon;
            }
        });
        defines.UNINSTALL_DISPLAY_NAME = packager.expandMacro(options.uninstallDisplayName || "${productName} ${version}", null, {}, false);
        if (commonOptions.isCreateDesktopShortcut === CommonWindowsInstallerConfiguration_1.DesktopShortcutCreationPolicy.NEVER) {
            defines.DO_NOT_CREATE_DESKTOP_SHORTCUT = null;
        }
        if (commonOptions.isCreateDesktopShortcut === CommonWindowsInstallerConfiguration_1.DesktopShortcutCreationPolicy.ALWAYS) {
            defines.RECREATE_DESKTOP_SHORTCUT = null;
        }
        if (!commonOptions.isCreateStartMenuShortcut) {
            defines.DO_NOT_CREATE_START_MENU_SHORTCUT = null;
        }
        if (options.displayLanguageSelector === true) {
            defines.DISPLAY_LANG_SELECTOR = null;
        }
        return asyncTaskManager.awaitTasks();
    }
    configureDefinesForAllTypeOfInstaller(defines) {
        const appInfo = this.packager.appInfo;
        const companyName = appInfo.companyName;
        if (companyName != null) {
            defines.COMPANY_NAME = companyName;
        }
        // electron uses product file name as app data, define it as well to remove on uninstall
        if (defines.APP_FILENAME !== appInfo.productFilename) {
            defines.APP_PRODUCT_FILENAME = appInfo.productFilename;
        }
        if (this.isWebInstaller) {
            defines.APP_PACKAGE_STORE_FILE = `${appInfo.updaterCacheDirName}\\${builder_util_runtime_1.CURRENT_APP_PACKAGE_FILE_NAME}`;
        }
        else {
            defines.APP_INSTALLER_STORE_FILE = `${appInfo.updaterCacheDirName}\\${builder_util_runtime_1.CURRENT_APP_INSTALLER_FILE_NAME}`;
        }
        if (!this.isWebInstaller && defines.APP_BUILD_DIR == null) {
            const options = this.options;
            if (options.useZip) {
                defines.ZIP_COMPRESSION = null;
            }
            defines.COMPRESSION_METHOD = options.useZip ? "zip" : "7z";
        }
    }
    async executeMakensis(defines, commands, script) {
        const args = this.options.warningsAsErrors === false ? [] : ["-WX"];
        args.push("-INPUTCHARSET", "UTF8");
        for (const name of Object.keys(defines)) {
            const value = defines[name];
            if (value == null) {
                args.push(`-D${name}`);
            }
            else {
                args.push(`-D${name}=${value}`);
            }
        }
        for (const name of Object.keys(commands)) {
            const value = commands[name];
            if (Array.isArray(value)) {
                for (const c of value) {
                    args.push(`-X${name} ${c}`);
                }
            }
            else {
                args.push(`-X${name} ${value}`);
            }
        }
        args.push("-");
        if (this.packager.debugLogger.isEnabled) {
            this.packager.debugLogger.add("nsis.script", script);
        }
        const nsisPath = await (0, nsisUtil_1.NSIS_PATH)();
        const command = path.join(nsisPath, process.platform === "darwin" ? "mac" : process.platform === "win32" ? "Bin" : "linux", process.platform === "win32" ? "makensis.exe" : "makensis");
        // if (process.platform === "win32") {
        // fix for an issue caused by virus scanners, locking the file during write
        // https://github.com/electron-userland/electron-builder/issues/5005
        await ensureNotBusy(commands["OutFile"].replace(/"/g, ""));
        // }
        await (0, builder_util_1.spawnAndWrite)(command, args, script, {
            // we use NSIS_CONFIG_CONST_DATA_PATH=no to build makensis on Linux, but in any case it doesn't use stubs as MacOS/Windows version, so, we explicitly set NSISDIR
            env: { ...process.env, NSISDIR: nsisPath },
            cwd: nsisUtil_1.nsisTemplatesDir,
        });
    }
    async computeCommonInstallerScriptHeader() {
        const packager = this.packager;
        const options = this.options;
        const scriptGenerator = new nsisScriptGenerator_1.NsisScriptGenerator();
        const langConfigurator = new nsisLang_1.LangConfigurator(options);
        scriptGenerator.include(path.join(nsisUtil_1.nsisTemplatesDir, "include", "StdUtils.nsh"));
        const includeDir = path.join(nsisUtil_1.nsisTemplatesDir, "include");
        scriptGenerator.addIncludeDir(includeDir);
        scriptGenerator.flags(["updated", "force-run", "keep-shortcuts", "no-desktop-shortcut", "delete-app-data", "allusers", "currentuser"]);
        (0, nsisLang_1.createAddLangsMacro)(scriptGenerator, langConfigurator);
        const taskManager = new builder_util_1.AsyncTaskManager(packager.info.cancellationToken);
        const pluginArch = this.isUnicodeEnabled ? "x86-unicode" : "x86-ansi";
        taskManager.add(async () => {
            scriptGenerator.addPluginDir(pluginArch, path.join(await nsisResourcePathPromise(), "plugins", pluginArch));
        });
        taskManager.add(async () => {
            const userPluginDir = path.join(packager.info.buildResourcesDir, pluginArch);
            const stat = await (0, fs_1.statOrNull)(userPluginDir);
            if (stat != null && stat.isDirectory()) {
                scriptGenerator.addPluginDir(pluginArch, userPluginDir);
            }
        });
        taskManager.addTask((0, nsisLang_1.addCustomMessageFileInclude)("messages.yml", packager, scriptGenerator, langConfigurator));
        if (!this.isPortable) {
            if (options.oneClick === false) {
                taskManager.addTask((0, nsisLang_1.addCustomMessageFileInclude)("assistedMessages.yml", packager, scriptGenerator, langConfigurator));
            }
            taskManager.add(async () => {
                const customInclude = await packager.getResource(this.options.include, "installer.nsh");
                if (customInclude != null) {
                    scriptGenerator.addIncludeDir(packager.info.buildResourcesDir);
                    scriptGenerator.include(customInclude);
                }
            });
        }
        await taskManager.awaitTasks();
        return scriptGenerator.build();
    }
    async computeFinalScript(originalScript, isInstaller, archs) {
        const packager = this.packager;
        const options = this.options;
        const langConfigurator = new nsisLang_1.LangConfigurator(options);
        const scriptGenerator = new nsisScriptGenerator_1.NsisScriptGenerator();
        const taskManager = new builder_util_1.AsyncTaskManager(packager.info.cancellationToken);
        if (isInstaller) {
            // http://stackoverflow.com/questions/997456/nsis-license-file-based-on-language-selection
            taskManager.add(() => (0, nsisLicense_1.computeLicensePage)(packager, options, scriptGenerator, langConfigurator.langs));
        }
        await taskManager.awaitTasks();
        if (this.isPortable) {
            return scriptGenerator.build() + originalScript;
        }
        const preCompressedFileExtensions = this.getPreCompressedFileExtensions();
        if (preCompressedFileExtensions != null && preCompressedFileExtensions.length !== 0) {
            for (const [arch, dir] of archs.entries()) {
                await generateForPreCompressed(preCompressedFileExtensions, dir, arch, scriptGenerator);
            }
        }
        const fileAssociations = packager.fileAssociations;
        if (fileAssociations.length !== 0) {
            scriptGenerator.include(path.join(path.join(nsisUtil_1.nsisTemplatesDir, "include"), "FileAssociation.nsh"));
            if (isInstaller) {
                const registerFileAssociationsScript = new nsisScriptGenerator_1.NsisScriptGenerator();
                for (const item of fileAssociations) {
                    const extensions = (0, builder_util_1.asArray)(item.ext).map(platformPackager_1.normalizeExt);
                    for (const ext of extensions) {
                        const customIcon = await packager.getResource((0, builder_util_1.getPlatformIconFileName)(item.icon, false), `${extensions[0]}.ico`);
                        let installedIconPath = "$appExe,0";
                        if (customIcon != null) {
                            installedIconPath = `$INSTDIR\\resources\\${path.basename(customIcon)}`;
                            registerFileAssociationsScript.file(installedIconPath, customIcon);
                        }
                        const icon = `"${installedIconPath}"`;
                        const commandText = `"Open with ${packager.appInfo.productName}"`;
                        const command = '"$appExe $\\"%1$\\""';
                        registerFileAssociationsScript.insertMacro("APP_ASSOCIATE", `"${ext}" "${item.name || ext}" "${item.description || ""}" ${icon} ${commandText} ${command}`);
                    }
                }
                scriptGenerator.macro("registerFileAssociations", registerFileAssociationsScript);
            }
            else {
                const unregisterFileAssociationsScript = new nsisScriptGenerator_1.NsisScriptGenerator();
                for (const item of fileAssociations) {
                    for (const ext of (0, builder_util_1.asArray)(item.ext)) {
                        unregisterFileAssociationsScript.insertMacro("APP_UNASSOCIATE", `"${(0, platformPackager_1.normalizeExt)(ext)}" "${item.name || ext}"`);
                    }
                }
                scriptGenerator.macro("unregisterFileAssociations", unregisterFileAssociationsScript);
            }
        }
        return scriptGenerator.build() + originalScript;
    }
}
exports.NsisTarget = NsisTarget;
async function generateForPreCompressed(preCompressedFileExtensions, dir, arch, scriptGenerator) {
    const resourcesDir = path.join(dir, "resources");
    const dirInfo = await (0, fs_1.statOrNull)(resourcesDir);
    if (dirInfo == null || !dirInfo.isDirectory()) {
        return;
    }
    const nodeModules = `${path.sep}node_modules`;
    const preCompressedAssets = await (0, fs_1.walk)(resourcesDir, (file, stat) => {
        if (stat.isDirectory()) {
            return !file.endsWith(nodeModules);
        }
        else {
            return preCompressedFileExtensions.some(it => file.endsWith(it));
        }
    });
    if (preCompressedAssets.length !== 0) {
        const macro = new nsisScriptGenerator_1.NsisScriptGenerator();
        for (const file of preCompressedAssets) {
            macro.file(`$INSTDIR\\${path.relative(dir, file).replace(/\//g, "\\")}`, file);
        }
        scriptGenerator.macro(`customFiles_${builder_util_1.Arch[arch]}`, macro);
    }
}
async function ensureNotBusy(outFile) {
    function isBusy(wasBusyBefore) {
        return new Promise((resolve, reject) => {
            fs.open(outFile, "r+", (error, fd) => {
                try {
                    if (error != null && error.code === "EBUSY") {
                        if (!wasBusyBefore) {
                            builder_util_1.log.info({}, "output file is locked for writing (maybe by virus scanner) => waiting for unlock...");
                        }
                        resolve(false);
                    }
                    else if (fd == null) {
                        resolve(true);
                    }
                    else {
                        fs.close(fd, () => resolve(true));
                    }
                }
                catch (error) {
                    reject(error);
                }
            });
        }).then(result => {
            if (result) {
                return true;
            }
            else {
                return new Promise(resolve => setTimeout(resolve, 2000)).then(() => isBusy(true));
            }
        });
    }
    await isBusy(false);
}
async function createPackageFileInfo(file) {
    return {
        path: file,
        size: (await (0, fs_extra_1.stat)(file)).size,
        sha512: await (0, hash_1.hashFile)(file),
    };
}
//# sourceMappingURL=NsisTarget.js.map