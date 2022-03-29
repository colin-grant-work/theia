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

import { injectable } from '@theia/core/shared/inversify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as request from 'request';
import { PluginDeployerResolver, PluginDeployerResolverContext } from '../../common';

/**
 * Resolver that handle the github: protocol
 * github:<org>/<repo>/<filename>@latest
 * github:<org>/<repo>/<filename>@<version>
 */
@injectable()
export class GithubPluginDeployerResolver implements PluginDeployerResolver {

    private static PREFIX = 'github:';

    private static GITHUB_ENDPOINT = 'https://github.com/';

    private unpackedFolder: string;

    constructor() {
        this.unpackedFolder = path.resolve(os.tmpdir(), 'github-remote');
        if (!fs.existsSync(this.unpackedFolder)) {
            fs.mkdirSync(this.unpackedFolder);
        }
    }

    /**
     * Grab the remote file specified by Github URL
     */
    async resolve(pluginResolverContext: PluginDeployerResolverContext): Promise<void> {
        const originId = pluginResolverContext.getOriginId();
        const extracted = /^github:(.*)\/(.*)\/(.*)$/gm.exec(originId);
        if (extracted?.length !== 4) {
            throw new Error(`Invalid extension: ${originId}`);
        }

        const [, orgName, repoName, file] = extracted;
        const [filename, version = 'latest'] = file.split('@');

        const versionToFetch = version === 'latest'
            ? await this.getLatestVersion(`${GithubPluginDeployerResolver.GITHUB_ENDPOINT}${orgName}/${repoName}/releases/latest`)
            : version;

        const unpackedLocation = await this.grabGithubFile(pluginResolverContext, orgName, repoName, filename, versionToFetch);

        pluginResolverContext.addPlugin(originId, unpackedLocation);
    }

    protected async getLatestVersion(url: string): Promise<string> {
        const response = await new Promise<request.Response>((resolve, reject) => {
            const options = { followRedirect: false };
            request.get(url, options).on('response', resolve).on('error', reject);
        });
        const { statusCode, headers: { location } } = response;
        // should have a redirect
        if (statusCode === 302 && location) {
            // parse redirect link
            const taggedValueArray = /^https:\/\/.*tag\/(.*)/gm.exec(location);
            if (taggedValueArray?.length !== 2) {
                throw new Error('The redirect link for latest is invalid ' + location);
            }
            return taggedValueArray[1];
        }
        throw new Error('Invalid GitHub link: latest version could not be determined.');
    }

    /*
     * Grab the github file specified by the plugin's ID
     */
    protected async grabGithubFile(pluginResolverContext: PluginDeployerResolverContext, orgName: string, repoName: string, filename: string, version: string): Promise<string> {

        const unpackedPath = path.resolve(this.unpackedFolder, path.basename(version + filename));

        // If file already exists, no need to download.
        if (!fs.existsSync(unpackedPath)) {
            await new Promise((resolve, reject) => {
                const dest = fs.createWriteStream(unpackedPath).once('finish', resolve);

                const url = GithubPluginDeployerResolver.GITHUB_ENDPOINT + orgName + '/' + repoName + '/releases/download/' + version + '/' + filename;

                request.get(url).on('error', reject).pipe(dest);
            });
        }

        return unpackedPath;
    }

    /**
     * Handle only the plugins that starts with github:
     */
    accept(pluginId: string): boolean {
        return pluginId.startsWith(GithubPluginDeployerResolver.PREFIX);
    }
}
