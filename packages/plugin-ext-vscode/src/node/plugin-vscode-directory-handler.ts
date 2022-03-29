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

import * as fs from '@theia/core/shared/fs-extra';
import * as path from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { RecursivePartial } from '@theia/core';
import {
    PluginDeployerDirectoryHandler,
    PluginDeployerEntry, PluginDeployerDirectoryHandlerContext,
    PluginDeployerEntryType, PluginPackage, PluginType
} from '@theia/plugin-ext';
import { FileUri } from '@theia/core/lib/node';
import { getTempDir } from '@theia/plugin-ext/lib/main/node/temp-dir-util';
import { PluginCliContribution } from '@theia/plugin-ext/lib/main/node/plugin-cli-contribution';
import filenamify = require('filenamify');

@injectable()
export class PluginVsCodeDirectoryHandler implements PluginDeployerDirectoryHandler {

    protected readonly deploymentDirectory = FileUri.create(getTempDir('vscode-copied'));

    @inject(PluginCliContribution) protected readonly pluginCli: PluginCliContribution;

    accept(plugin: PluginDeployerEntry): boolean {
        console.debug(`Resolving "${plugin.id()}" as a VS Code extension...`);
        return this.resolvePackage(plugin) || this.resolveFromSources(plugin) || this.resolveFromVSIX(plugin) || this.resolveFromNpmTarball(plugin);
    }

    async handle(context: PluginDeployerDirectoryHandlerContext): Promise<void> {
        if (this.pluginCli.copyUncomprossedPlugins() && context.pluginEntry().type === PluginType.User) {
            const id = context.pluginEntry().id();
            const origin = context.pluginEntry().path();
            const targetDir = await this.getExtensionDir(context);
            try {
                if (fs.existsSync(targetDir)) {
                    console.log(`[${id}]: already copied.`);
                } else {
                    console.log(`[${id}]: copying to "${targetDir}"`);
                    await fs.mkdirp(FileUri.fsPath(this.deploymentDirectory));
                    fs.copyFileSync(origin, targetDir);
                }
                context.pluginEntry().updatePath(targetDir);
            } catch (e) {
                console.log(`SENTINEL FOR AN ERROR COPYING ${origin} -> ${targetDir} ${context.pluginEntry().originalPath()} [${id}] ${process.pid}, ${process.ppid}`, e);
            }
        }
        context.pluginEntry().accept(PluginDeployerEntryType.BACKEND);
    }

    protected resolveFromSources(plugin: PluginDeployerEntry): boolean {
        const pluginPath = plugin.path();
        return this.resolvePackage(plugin, { pluginPath, pck: this.requirePackage(pluginPath) });
    }

    protected resolveFromVSIX(plugin: PluginDeployerEntry): boolean {
        if (!fs.existsSync(path.join(plugin.path(), 'extension.vsixmanifest'))) {
            return false;
        }
        const pluginPath = path.join(plugin.path(), 'extension');
        return this.resolvePackage(plugin, { pluginPath, pck: this.requirePackage(pluginPath) });
    }

    protected resolveFromNpmTarball(plugin: PluginDeployerEntry): boolean {
        const pluginPath = path.join(plugin.path(), 'package');
        return this.resolvePackage(plugin, { pluginPath, pck: this.requirePackage(pluginPath) });
    }

    protected resolvePackage(plugin: PluginDeployerEntry, options?: {
        pluginPath: string
        pck?: RecursivePartial<PluginPackage>
    }): boolean {
        const { pluginPath, pck } = options || {
            pluginPath: plugin.path(),
            pck: plugin.getValue('package.json')
        };
        if (!pck || !pck.name || !pck.version || !pck.engines || !pck.engines.vscode) {
            return false;
        }
        if (options) {
            plugin.storeValue('package.json', pck);
            plugin.rootPath = plugin.path();
            plugin.updatePath(pluginPath);
        }
        console.log(`Resolved "${plugin.id()}" to a VS Code extension "${pck.name}@${pck.version}" with engines:`, pck.engines);
        return true;
    }

    protected requirePackage(pluginPath: string): PluginPackage | undefined {
        try {
            return fs.readJSONSync(path.join(pluginPath, 'package.json'));
        } catch {
            return undefined;
        }
    }

    protected async getExtensionDir(context: PluginDeployerDirectoryHandlerContext): Promise<string> {
        return FileUri.fsPath(this.deploymentDirectory.resolve(filenamify(context.pluginEntry().id(), { replacement: '_' })));
    }
}
