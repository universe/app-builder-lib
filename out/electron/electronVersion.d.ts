import { Lazy } from "lazy-val";
import { Configuration } from "../configuration";
export declare type MetadataValue = Lazy<{
    [key: string]: any;
} | null>;
export declare function getElectronVersion(projectDir: string, config?: Configuration): Promise<string>;
export declare function getElectronVersionFromInstalled(projectDir: string): Promise<string | null>;
export declare function getElectronPackage(projectDir: string): Promise<any>;
