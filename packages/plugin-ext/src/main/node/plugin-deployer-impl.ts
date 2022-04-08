// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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

/* eslint-disable @typescript-eslint/no-explicit-any */

import { injectable, optional, multiInject, inject, named } from '@theia/core/shared/inversify';
import {
    PluginDeployerResolver, PluginDeployerFileHandler, PluginDeployerDirectoryHandler,
    PluginDeployerEntry, PluginDeployer, PluginDeployerParticipant, PluginDeployerStartContext,
    PluginDeployerResolverInit, PluginDeployerEntryType, PluginDeployerHandler, PluginType, UnresolvedPluginEntry, HostedPluginServer
} from '../../common/plugin-protocol';
import { PluginDeployerEntryImpl } from './plugin-deployer-entry-impl';
import {
    PluginDeployerResolverContextImpl,
    PluginDeployerResolverInitImpl
} from './plugin-deployer-resolver-context-impl';
import { ProxyPluginDeployerEntry } from './plugin-deployer-proxy-entry-impl';
import { PluginDeployerFileHandlerContextImpl } from './plugin-deployer-file-handler-context-impl';
import { PluginDeployerDirectoryHandlerContextImpl } from './plugin-deployer-directory-handler-context-impl';
import { ILogger, Emitter, ContributionProvider, Disposable } from '@theia/core';
import { PluginCliContribution } from './plugin-cli-contribution';
import { Measurement, Stopwatch } from '@theia/core/lib/common';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import * as nodeFS from 'fs';
import URI from '@theia/core/lib/common/uri';

@injectable()
export class PluginDeployerImpl implements PluginDeployer {

    protected readonly onDidDeployEmitter = new Emitter<void>();
    readonly onDidDeploy = this.onDidDeployEmitter.event;
    protected readonly servers: HostedPluginServer[] = [];

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(PluginDeployerHandler)
    protected readonly pluginDeployerHandler: PluginDeployerHandler;

    @inject(PluginCliContribution)
    protected readonly cliContribution: PluginCliContribution;

    @inject(Stopwatch)
    protected readonly stopwatch: Stopwatch;

    @inject(EnvVariablesServer)
    protected readonly environmentVariables: EnvVariablesServer;

    /**
     * Inject all plugin resolvers found at runtime.
     */
    @optional() @multiInject(PluginDeployerResolver)
    private pluginResolvers: PluginDeployerResolver[];

    /**
     * Inject all file handler for local resolved plugins.
     */
    @optional() @multiInject(PluginDeployerFileHandler)
    private pluginDeployerFileHandlers: PluginDeployerFileHandler[];

    /**
     * Inject all directory handler for local resolved plugins.
     */
    @optional() @multiInject(PluginDeployerDirectoryHandler)
    private pluginDeployerDirectoryHandlers: PluginDeployerDirectoryHandler[];

    @inject(ContributionProvider) @named(PluginDeployerParticipant)
    protected readonly participants: ContributionProvider<PluginDeployerParticipant>;

    public start(): void {
        this.logger.debug('Starting the deployer with the list of resolvers', this.pluginResolvers);
        this.doStart();
    }

    registerPluginServer(server: HostedPluginServer): Disposable {
        this.servers.push(server);
        return Disposable.create(() => {
            const idx = this.servers.indexOf(server);
            if (idx !== -1) {
                this.servers.splice(idx, 1);
            }
        });
    }

    public async initResolvers(): Promise<void> {
        const pluginDeployerResolverInit: PluginDeployerResolverInit = new PluginDeployerResolverInitImpl();
        await Promise.all(this.pluginResolvers.map(async pluginResolver => pluginResolver.init?.(pluginDeployerResolverInit)));
    }

    protected async doStart(): Promise<void> {

        // init resolvers
        await this.initResolvers();

        // check THEIA_DEFAULT_PLUGINS or THEIA_PLUGINS env var
        const defaultPluginsValue = process.env.THEIA_DEFAULT_PLUGINS || undefined;
        const pluginsValue = process.env.THEIA_PLUGINS || undefined;
        // check the `--plugins` CLI option
        const defaultPluginsValueViaCli = this.cliContribution.localDir();

        this.logger.debug('Found the list of default plugins ID on env:', defaultPluginsValue);
        this.logger.debug('Found the list of plugins ID on env:', pluginsValue);
        this.logger.debug('Found the list of default plugins ID from CLI:', defaultPluginsValueViaCli);

        // transform it to array
        const defaultPluginIdList = defaultPluginsValue ? defaultPluginsValue.split(',') : [];
        const pluginIdList = pluginsValue ? pluginsValue.split(',') : [];
        const systemEntries = defaultPluginIdList.concat(pluginIdList).concat(defaultPluginsValueViaCli ? defaultPluginsValueViaCli.split(',') : []);

        const userEntries: string[] = [];
        const context: PluginDeployerStartContext = { userEntries, systemEntries };

        for (const contribution of this.participants.getContributions()) {
            if (contribution.onWillStart) {
                await contribution.onWillStart(context);
            }
        }

        const deployPlugins = this.measure('deployPlugins');
        const unresolvedUserEntries = context.userEntries.map(id => ({
            id,
            type: PluginType.User
        }));
        const unresolvedSystemEntries = context.systemEntries.map(id => ({
            id,
            type: PluginType.System
        }));
        const plugins = await this.resolvePlugins([...unresolvedUserEntries, ...unresolvedSystemEntries]);
        deployPlugins.log('Resolve plugins list');
        await this.deployPlugins(plugins);
        deployPlugins.log('Deploy plugins list');
    }

    async undeploy(pluginId: string): Promise<void> {
        if (await this.pluginDeployerHandler.undeployPlugin(pluginId)) {
            this.onDidDeployEmitter.fire();
        }
    }

    async undeploySafely(pluginId: string): Promise<void> {
        console.log("SENTINEL: I'M NOT GOING TO DO THAT, BUT HERE ARE THE ACTIVE PLUGINS", (await Promise.all(this.servers.map(server => server.getActivePluginIds()))));
        // const dependents = this.getDependentsOf(pluginId);
        // if (dependents.length) {
        //     throw new Error(`Cannot uninstall ${pluginId} because it is depended on by ${dependents.join(', ')}.`);
        // }
        // this.markAsUninstalled(pluginId);
        await this.pluginDeployerHandler.undeployPluginSafely(pluginId);
    }

    protected async handleDeferredUninstallation(): Promise<void> {
        if (this.servers.length === 0) {
            await this.getToUninstall().then(toUninstall => Promise.all(toUninstall.map(plugin => this.pluginDeployerHandler.undeployPluginSafely(plugin))));
        }
    }

    protected async getToUninstall(): Promise<string[]> {
        try {
            const toUninstallPath = await this.getToUninstallPath();
            const maybeToUninstall = JSON.parse(await nodeFS.promises.readFile(toUninstallPath, 'utf-8'));
            if (Array.isArray(maybeToUninstall) && maybeToUninstall.every(item => typeof item === 'string')) {
                return maybeToUninstall;
            }
        } catch { }
        return [];
    }

    protected async clearToUninstall(): Promise<void> {
        return nodeFS.promises.writeFile(await this.getToUninstallPath(), '[]');
    }

    protected async getToUninstallPath(): Promise<string> {
        return new URI(await this.environmentVariables.getConfigDirUri()).resolve('extensions').resolve('.to-uninstall')['codeUri'].fsPath;
    }

    // protected isActive(pluginId: string): Promise<boolean> {
    //     return new Error("You haven't written me yet.");
    // }

    // protected markAsUninstalled(pluginId: string): void {
    //     return new Error("You haven't written me yet.");
    // }

    // protected getDependentsOf(pluginId: string): string[] {
    //     return void 0;
    // }

    async deploy(plugin: UnresolvedPluginEntry): Promise<void> {
        const deploy = this.measure('deploy');
        await this.deployMultipleEntries([plugin]);
        deploy.log(`Deploy plugin ${plugin}`);
    }

    protected async deployMultipleEntries(plugins: UnresolvedPluginEntry[]): Promise<void> {
        const pluginsToDeploy = await this.resolvePlugins(plugins);
        await this.deployPlugins(pluginsToDeploy);
    }

    /**
     * Resolves plugins for the given type.
     *
     * Only call it a single time before triggering a single deploy to prevent re-resolving of extension dependencies, i.e.
     * ```ts
     * const deployer: PluginDeployer;
     * deployer.deployPlugins(await deployer.resolvePlugins(allPluginEntries));
     * ```
     */
    async resolvePlugins(plugins: UnresolvedPluginEntry[]): Promise<PluginDeployerEntry[]> {
        const visited = new Set<string>();
        const pluginsToDeploy = new Map<string, PluginDeployerEntry>();
        const notToDeploy = new Set(await this.pluginDeployerHandler.getObsoletePluginIds());

        let queue: UnresolvedPluginEntry[] = [...plugins];
        while (queue.length) {
            const dependenciesChunk: Array<{
                dependencies: Map<string, string>
                type: PluginType
            }> = [];
            const workload: UnresolvedPluginEntry[] = [];
            while (queue.length) {
                const current = queue.shift()!;
                if (visited.has(current.id)) {
                    continue;
                } else {
                    workload.push(current);
                }
                visited.add(current.id);
            }
            queue = [];
            await Promise.all(workload.map(async ({ id, type }) => {
                if (type === undefined) {
                    type = PluginType.System;
                }
                try {
                    const pluginDeployerEntries = (await this.resolvePlugin(id, type)).filter(plugin => !notToDeploy.has(plugin.id()));
                    await this.applyFileHandlers(pluginDeployerEntries);
                    await this.applyDirectoryFileHandlers(pluginDeployerEntries);
                    for (const deployerEntry of pluginDeployerEntries) {
                        const dependencies = await this.pluginDeployerHandler.getPluginDependencies(deployerEntry);
                        if (dependencies && !pluginsToDeploy.has(dependencies.metadata.model.id)) {
                            pluginsToDeploy.set(dependencies.metadata.model.id, deployerEntry);
                            if (dependencies.mapping) {
                                dependenciesChunk.push({ dependencies: dependencies.mapping, type });
                            }
                        }
                    }
                    console.log('SENTINEL FOR WHAT WE KNOW ABOUT DEPENDENCIES AT THE END OF ALL OF THAT:', dependenciesChunk);
                } catch (e) {
                    console.error(`Failed to resolve plugins from '${id}'`, e);
                }
            }));
            for (const { dependencies, type } of dependenciesChunk) {
                for (const [dependency, deployableDependency] of dependencies) {
                    if (!pluginsToDeploy.has(dependency)) {
                        queue.push({
                            id: deployableDependency,
                            type
                        });
                    }
                }
            }
        }
        return [...pluginsToDeploy.values()];
    }

    /**
     * deploy all plugins that have been accepted
     */
    async deployPlugins(pluginsToDeploy: PluginDeployerEntry[]): Promise<any> {
        const acceptedPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted());
        const acceptedFrontendPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted(PluginDeployerEntryType.FRONTEND));
        const acceptedBackendPlugins = pluginsToDeploy.filter(pluginDeployerEntry => pluginDeployerEntry.isAccepted(PluginDeployerEntryType.BACKEND));

        this.logger.debug('the accepted plugins are', acceptedPlugins);
        this.logger.debug('the acceptedFrontendPlugins plugins are', acceptedFrontendPlugins);
        this.logger.debug('the acceptedBackendPlugins plugins are', acceptedBackendPlugins);

        acceptedPlugins.forEach(plugin => {
            this.logger.debug('will deploy plugin', plugin.id(), 'with changes', JSON.stringify(plugin.getChanges()), 'and this plugin has been resolved by', plugin.resolvedBy());
        });

        // local path to launch
        const pluginPaths = acceptedBackendPlugins.map(pluginEntry => pluginEntry.path());
        this.logger.debug('local path to deploy on remote instance', pluginPaths);

        await Promise.all([
            // start the backend plugins
            this.pluginDeployerHandler.deployBackendPlugins(acceptedBackendPlugins),
            this.pluginDeployerHandler.deployFrontendPlugins(acceptedFrontendPlugins)
        ]);
        this.onDidDeployEmitter.fire(undefined);
    }

    /**
     * If there are some single files, try to see if we can work on these files (like unpacking it, etc)
     */
    public async applyFileHandlers(pluginDeployerEntries: PluginDeployerEntry[]): Promise<any> {
        const waitPromises: Array<Promise<any>> = [];

        pluginDeployerEntries.filter(pluginDeployerEntry => pluginDeployerEntry.isResolved()).forEach(pluginDeployerEntry => {
            this.pluginDeployerFileHandlers.forEach(pluginFileHandler => {
                const proxyPluginDeployerEntry = new ProxyPluginDeployerEntry(pluginFileHandler, (pluginDeployerEntry) as PluginDeployerEntryImpl);
                if (pluginFileHandler.accept(proxyPluginDeployerEntry)) {
                    const pluginDeployerFileHandlerContext = new PluginDeployerFileHandlerContextImpl(proxyPluginDeployerEntry);
                    waitPromises.push(pluginFileHandler.handle(pluginDeployerFileHandlerContext));
                }
            });

        });
        return Promise.all(waitPromises);
    }

    /**
     * Check for all registered directories to see if there are some plugins that can be accepted to be deployed.
     */
    public async applyDirectoryFileHandlers(pluginDeployerEntries: PluginDeployerEntry[]): Promise<any> {
        const waitPromises: Array<Promise<any>> = [];

        pluginDeployerEntries.filter(pluginDeployerEntry => pluginDeployerEntry.isResolved()).forEach(pluginDeployerEntry => {
            this.pluginDeployerDirectoryHandlers.forEach(pluginDirectoryHandler => {
                const proxyPluginDeployerEntry = new ProxyPluginDeployerEntry(pluginDirectoryHandler, (pluginDeployerEntry) as PluginDeployerEntryImpl);
                if (pluginDirectoryHandler.accept(proxyPluginDeployerEntry)) {
                    const pluginDeployerDirectoryHandlerContext = new PluginDeployerDirectoryHandlerContextImpl(proxyPluginDeployerEntry);
                    waitPromises.push(pluginDirectoryHandler.handle(pluginDeployerDirectoryHandlerContext));
                }
            });

        });
        return Promise.all(waitPromises);
    }

    /**
     * Check a plugin ID see if there are some resolvers that can handle it. If there is a matching resolver, then we resolve the plugin
     */
    public async resolvePlugin(pluginId: string, type: PluginType = PluginType.System): Promise<PluginDeployerEntry[]> {
        const pluginDeployerEntries: PluginDeployerEntry[] = [];
        const foundPluginResolver = this.pluginResolvers.find(pluginResolver => pluginResolver.accept(pluginId));
        // there is a resolver for the input
        if (foundPluginResolver) {

            // create context object
            const context = new PluginDeployerResolverContextImpl(foundPluginResolver, pluginId);

            await foundPluginResolver.resolve(context);

            context.getPlugins().forEach(entry => {
                entry.type = type;
                pluginDeployerEntries.push(entry);
            });
        } else {
            // log it for now
            this.logger.error('No plugin resolver found for the entry', pluginId);
            const unresolvedEntry = new PluginDeployerEntryImpl(pluginId, pluginId);
            unresolvedEntry.type = type;
            pluginDeployerEntries.push(unresolvedEntry);
        }

        return pluginDeployerEntries;
    }

    protected measure(name: string): Measurement {
        return this.stopwatch.start(name);
    }
}
