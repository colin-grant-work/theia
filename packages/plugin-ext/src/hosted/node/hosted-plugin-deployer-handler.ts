// *****************************************************************************
// Copyright (C) 2019 RedHat and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
// *****************************************************************************

import * as fs from '@theia/core/shared/fs-extra';
import { injectable, inject } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core';
import {
    PluginDeployerHandler, PluginDeployerEntry, PluginEntryPoint,
    DeployedPlugin, PluginDependencies, PluginType, PluginPackage, PluginModel
} from '../../common/plugin-protocol';
import { HostedPluginReader } from './plugin-reader';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { HostedPluginLocalizationService } from './hosted-plugin-localization-service';
import { Stopwatch } from '@theia/core/lib/common';
import { PluginObsoletionHandler } from './plugin-obsoletion-handler';

@injectable()
export class HostedPluginDeployerHandler implements PluginDeployerHandler {

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(HostedPluginReader)
    protected readonly reader: HostedPluginReader;

    @inject(HostedPluginLocalizationService)
    protected readonly localizationService: HostedPluginLocalizationService;

    @inject(Stopwatch)
    protected readonly stopwatch: Stopwatch;

    @inject(PluginObsoletionHandler) protected readonly obsoletionHandler: PluginObsoletionHandler;

    protected readonly deployedLocations = new Map<string, Set<string>>();
    protected readonly originalLocations = new Map<string, string>();

    /**
     * Managed plugin metadata backend entries.
     */
    protected readonly deployedBackendPlugins = new Map<string, DeployedPlugin>();
    /**
     * Managed plugin metadata frontend entries.
     */
    protected readonly deployedFrontendPlugins = new Map<string, DeployedPlugin>();

    protected backendPluginsMetadataDeferred = new Deferred<void>();

    protected frontendPluginsMetadataDeferred = new Deferred<void>();

    async getDeployedFrontendPluginIds(): Promise<string[]> {
        // await first deploy
        await this.frontendPluginsMetadataDeferred.promise;
        // fetch the last deployed state
        return [...this.deployedFrontendPlugins.keys()];
    }

    async getDeployedBackendPluginIds(): Promise<string[]> {
        // await first deploy
        await this.backendPluginsMetadataDeferred.promise;
        // fetch the last deployed state
        return [...this.deployedBackendPlugins.keys()];
    }

    async getObsoletePluginIds(): Promise<string[]> {
        return this.obsoletionHandler.getObsoletePluginIds();
    }

    getDeployedPlugin(pluginId: string): DeployedPlugin | undefined {
        const metadata = this.deployedBackendPlugins.get(pluginId);
        if (metadata) {
            return metadata;
        }
        return this.deployedFrontendPlugins.get(pluginId);
    }

    /**
     * @throws never! in order to isolate plugin deployment
     */
    async getPluginDependencies(entry: PluginDeployerEntry): Promise<PluginDependencies | undefined> {
        const pluginPath = entry.path();
        try {
            const manifest = await this.reader.readPackage(pluginPath);
            if (!manifest) {
                return undefined;
            }
            return this.getDependenciesFromManifest(manifest, entry.type);
        } catch (e) {
            console.error(`Failed to load plugin dependencies from '${pluginPath}' path`, e);
            return undefined;
        }
    }

    async getPluginDependenciesById(id: string): Promise<PluginDependencies | undefined> {
        const plugin = this.getDeployedPlugin(id);
        const hasEngines = (candidate: PluginModel): candidate is PluginModel & { engines: PluginPackage['engines'] } => true;
        if (plugin && hasEngines(plugin.metadata.model)) {
            return this.getDependenciesFromManifest(plugin.metadata.model, plugin.type!);
        }
    }

    protected async getDependenciesFromManifest(manifest: PluginPackage, type: PluginType): Promise<PluginDependencies> {
        const metadata = this.reader.readMetadata(manifest);
        const dependencies: PluginDependencies = { metadata };
        // Do not resolve system (aka builtin) plugins because it should be done statically at build time.
        if (type !== PluginType.System) {
            dependencies.mapping = this.reader.readDependencies(manifest);
        }
        return dependencies;
    }

    async deployFrontendPlugins(frontendPlugins: PluginDeployerEntry[]): Promise<void> {
        for (const plugin of frontendPlugins) {
            await this.deployPlugin(plugin, 'frontend');
        }
        // resolve on first deploy
        this.frontendPluginsMetadataDeferred.resolve(undefined);
    }

    async deployBackendPlugins(backendPlugins: PluginDeployerEntry[]): Promise<void> {
        for (const plugin of backendPlugins) {
            await this.deployPlugin(plugin, 'backend');
        }
        // rebuild translation config after deployment
        this.localizationService.buildTranslationConfig([...this.deployedBackendPlugins.values()]);
        // resolve on first deploy
        this.backendPluginsMetadataDeferred.resolve(undefined);
    }

    /**
     * @throws never! in order to isolate plugin deployment
     */
    protected async deployPlugin(entry: PluginDeployerEntry, entryPoint: keyof PluginEntryPoint): Promise<void> {
        const pluginPath = entry.path();
        const deployPlugin = this.stopwatch.start('deployPlugin');
        try {
            const manifest = await this.reader.readPackage(pluginPath);
            if (!manifest) {
                deployPlugin.error(`Failed to read ${entryPoint} plugin manifest from '${pluginPath}''`);
                return;
            }

            const metadata = this.reader.readMetadata(manifest);

            const deployedLocations = this.deployedLocations.get(metadata.model.id) || new Set<string>();
            deployedLocations.add(entry.rootPath);
            this.deployedLocations.set(metadata.model.id, deployedLocations);
            this.originalLocations.set(metadata.model.id, entry.originalPath());

            const deployedPlugins = entryPoint === 'backend' ? this.deployedBackendPlugins : this.deployedFrontendPlugins;
            if (deployedPlugins.has(metadata.model.id)) {
                deployPlugin.debug(`Skipped ${entryPoint} plugin ${metadata.model.name} already deployed`);
                return;
            }

            const { type } = entry;
            const deployed: DeployedPlugin = { metadata, type };
            deployed.contributes = this.reader.readContribution(manifest);
            this.localizationService.deployLocalizations(deployed);
            deployedPlugins.set(metadata.model.id, deployed);
            deployPlugin.log(
                `Deployed ${entryPoint} plugin "${metadata.model.name}@${metadata.model.version}"`
                + ` from "${metadata.model.entryPoint[entryPoint] || pluginPath}", to ${entry.rootPath}. Maybe from ${entry.originalPath()}`,
            );
        } catch (e) {
            deployPlugin.error(`Failed to deploy ${entryPoint} plugin from '${pluginPath}' path`, e);
        }
    }

    async undeployPlugin(pluginId: string): Promise<boolean> {
        this.deployedBackendPlugins.delete(pluginId);
        this.deployedFrontendPlugins.delete(pluginId);
        console.log('SENTINEL FOR DEPLOYED AND ORIGINAL', pluginId, this.originalLocations.get(pluginId), Array.from(this.deployedLocations.get(pluginId) || []));
        const deployedLocations = this.deployedLocations.get(pluginId);
        if (!deployedLocations) {
            return false;
        }

        const undeployPlugin = this.stopwatch.start('undeployPlugin');
        this.deployedLocations.delete(pluginId);

        for (const location of deployedLocations) {
            try {
                await fs.remove(location);
                undeployPlugin.log(`[${pluginId}]: undeployed from "${location}"`);
            } catch (e) {
                undeployPlugin.error(`[${pluginId}]: failed to undeploy from location "${location}". reason:`, e);
            }
        }

        return true;
    }

    async undeployPluginSafely(pluginId: string): Promise<boolean> {
        const originalLocation = this.originalLocations.get(pluginId);
        const deployedLocations = this.deployedLocations.get(pluginId);
        if (!originalLocation) {
            return false;
        }
        if (!deployedLocations?.has(originalLocation)) {
            try {
                console.log(`[${pluginId}] Deleting source files from ${originalLocation}.`);
                await fs.remove(originalLocation);
            } catch {
                console.error(`[${pluginId}]: Failed to remove source files.`);
            }
        } else {
            console.warn(`[${pluginId}] Cannot remove source files. It is deployed in its original location: ${originalLocation}. Plugin will be uninstalled on restart.`);
        }
        await this.obsoletionHandler.markAsObsolete(pluginId);
        return true;
    }
}
