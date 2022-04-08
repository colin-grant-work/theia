// *****************************************************************************
// Copyright (C) 2022 Ericsson and others.
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

import * as path from 'path';
import * as fs from '@theia/core/shared/fs-extra';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { Emitter, Event } from '@theia/core';

/**
 * Tracks plugins that have been marked as obsolete. A plugin is obsolete if its uninstallation has been requested but it has not yet been deleted.
 */
@injectable()
export class PluginObsoletionHandler {
    protected readonly obsoletePlugins: string[] = [];
    protected obsoletePluginURIDeferred = new Deferred<string>();
    protected ready = new Deferred();

    protected readonly onDidChangeObsoletePluginsEmitter = new Emitter<string[]>();

    get onDidChangeObsoletePlugins(): Event<string[]> {
        return this.onDidChangeObsoletePluginsEmitter.event;
    }

    protected get obsoletePluginURI(): Promise<string> {
        return this.obsoletePluginURIDeferred.promise;
    }

    @inject(EnvVariablesServer)
    protected readonly environments: EnvVariablesServer;

    @postConstruct()
    protected init(): void {
        this.obsoletePluginURIDeferred.resolve(this.environments.getConfigDirUri().then(configURI => path.resolve(configURI, '.obsolete-plugins')));
        this.retrieveFromFile().then(() => this.ready.resolve());
    }

    async getObsoletePluginIds(): Promise<string[]> {
        await this.ready.promise;
        return this.obsoletePlugins;
    }

    async markAsObsolete(pluginId: string): Promise<void> {
        if (!this.obsoletePlugins.includes(pluginId)) {
            this.obsoletePlugins.push(pluginId);
            await this.updateFile();
            this.onDidChangeObsoletePluginsEmitter.fire(this.obsoletePlugins);
        }
    }

    async collateDeployedAndObsolete(deployedPlugins: string[]): Promise<void> {
        const obsolete = new Set(this.obsoletePlugins);
        this.obsoletePlugins.length = 0;
        for (const id of new Set(deployedPlugins)) {
            if (obsolete.has(id)) {
                this.obsoletePlugins.push(id);
            }
        }
        // Only way they can be the same size is if all the same plugins got added back.
        if (obsolete.size !== this.obsoletePlugins.length) {
            await this.updateFile();
            this.onDidChangeObsoletePluginsEmitter.fire(this.obsoletePlugins);
        }
    }

    protected async retrieveFromFile(): Promise<string[]> {
        const target = await this.obsoletePluginURI;
        try {
            const plugins = fs.readJSON(target);
            if (Array.isArray(plugins) && plugins.every(plugin => typeof plugin === 'string')) {
                return plugins;
            } else {
                await this.updateFile([]);
                return [];
            }
        } catch {
            return [];
        }
    }

    protected async updateFile(obsoletePlugins = this.obsoletePlugins): Promise<void> {
        const target = await this.obsoletePluginURI;
        await fs.writeFile(target, JSON.stringify(obsoletePlugins));
    }
}
