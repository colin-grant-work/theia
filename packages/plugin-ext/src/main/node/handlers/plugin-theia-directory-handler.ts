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

import {
    PluginDeployerDirectoryHandler,
    PluginDeployerEntry, PluginPackage, PluginDeployerDirectoryHandlerContext,
    PluginDeployerEntryType,
    PluginType
} from '../../../common/plugin-protocol';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as fs from '@theia/core/shared/fs-extra';
import * as path from 'path';
import filenamify = require('filenamify');
import { FileUri } from '@theia/core/lib/node';
import { PluginCliContribution } from '../plugin-cli-contribution';
import { getTempDir } from '../temp-dir-util';
@injectable()
export class PluginTheiaDirectoryHandler implements PluginDeployerDirectoryHandler {

    protected readonly deploymentDirectory = FileUri.create(getTempDir('theia-copied'));

    @inject(PluginCliContribution) protected readonly pluginCli: PluginCliContribution;

    accept(resolvedPlugin: PluginDeployerEntry): boolean {

        console.log('PluginTheiaDirectoryHandler: accepting plugin with path', resolvedPlugin.path());

        // handle only directories
        if (resolvedPlugin.isFile()) {
            return false;
        }

        // is there a package.json ?
        const packageJsonPath = path.resolve(resolvedPlugin.path(), 'package.json');
        const existsPackageJson: boolean = fs.existsSync(packageJsonPath);
        if (!existsPackageJson) {
            return false;
        }

        let packageJson: PluginPackage = resolvedPlugin.getValue('package.json');
        if (!packageJson) {
            packageJson = fs.readJSONSync(packageJsonPath);
            resolvedPlugin.storeValue('package.json', packageJson);
        }

        if (!packageJson.engines) {
            return false;
        }

        if (packageJson.engines && packageJson.engines.theiaPlugin) {
            return true;
        }

        return false;

    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async handle(context: PluginDeployerDirectoryHandlerContext): Promise<any> {
        if (this.pluginCli.copyUncomprossedPlugins() && context.pluginEntry().type === PluginType.User) {
            const id = context.pluginEntry().id();
            const targetDir = await this.getExtensionDir(context);
            try {
                if (fs.existsSync(targetDir)) {
                    console.log(`[${id}]: already copied.`);
                } else {
                    console.log(`[${id}]: copying to "${targetDir}"`);
                    await fs.mkdirp(FileUri.fsPath(this.deploymentDirectory));
                    fs.copyFileSync(context.pluginEntry().path(), targetDir);
                }
                context.pluginEntry().updatePath(targetDir);
            } catch (e) {
                console.log(`SENTINEL FOR AN ERROR COPYING [${id}]`, e);
            }
        }
        const types: PluginDeployerEntryType[] = [];
        const packageJson: PluginPackage = context.pluginEntry().getValue('package.json');
        if (packageJson.theiaPlugin && packageJson.theiaPlugin.backend) {
            types.push(PluginDeployerEntryType.BACKEND);
        }
        if (packageJson.theiaPlugin && packageJson.theiaPlugin.frontend) {
            types.push(PluginDeployerEntryType.FRONTEND);
        }

        context.pluginEntry().accept(...types);
        return true;
    }

    protected async getExtensionDir(context: PluginDeployerDirectoryHandlerContext): Promise<string> {
        return FileUri.fsPath(this.deploymentDirectory.resolve(filenamify(context.pluginEntry().id(), { replacement: '_' })));
    }
}
