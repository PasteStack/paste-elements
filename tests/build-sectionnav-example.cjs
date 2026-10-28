/*!
 * Copyright (c) 2017–present Tomshley LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     https://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const binary = process.argv[2] || process.env.PASTE_ASSETGRAPH_BIN || 'paste-assetgraph';
const build = spawnSync(binary, ['build', '--config', 'examples/sectionnav.conf'], {cwd: root, stdio: 'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const output = path.join(root, 'target/sectionnav-example');
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
const asset = manifest.assets['css/sectionnav.css'];
if (!asset) throw new Error('Missing example asset: css/sectionnav.css');
fs.copyFileSync(path.join(output, asset.output.replace(/^\//, '')), path.join(output, 'sectionnav.css'));
fs.copyFileSync(path.join(root, 'examples/sectionnav.html'), path.join(output, 'index.html'));
console.log('Standalone example built at ' + path.join(output, 'index.html'));
