const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binary = process.argv[2] || process.env.PASTE_ASSETGRAPH_BIN || 'paste-assetgraph';
// The core `paste` modules are a separate release; this repository must not
// encode where a machine keeps them.
const coreJs = process.env.PASTE_CORE_JS;
if (!coreJs) {
    throw new Error('Set PASTE_CORE_JS to the src/js directory of a paste release (or checkout) before building the example');
}
if (!fs.existsSync(path.join(coreJs, 'paste.js'))) {
    throw new Error('PASTE_CORE_JS does not contain paste.js: ' + coreJs);
}
const runConfig = path.join(root, 'target/marquee-example.conf');
fs.mkdirSync(path.dirname(runConfig), {recursive: true});
fs.writeFileSync(
    runConfig,
    fs.readFileSync(path.join(root, 'examples/marquee.conf'), 'utf8') +
        'include-paths = ["' + coreJs + '"]\n'
);
const build = spawnSync(binary, ['build', '--config', path.relative(root, runConfig)], {cwd: root, stdio: 'inherit'});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const output = path.join(root, 'target/marquee-example');
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
const visited = new Set();
const scripts = [];
function content(key) {
    const asset = manifest.assets[key];
    if (!asset) throw new Error('Missing example asset: ' + key);
    return fs.readFileSync(path.join(output, asset.output.replace(/^\//, '')), 'utf8');
}
function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const asset = manifest.assets[key];
    if (!asset) throw new Error('Missing example dependency: ' + key);
    for (const dependency of asset.dependencies) {
        visit('js/' + dependency.replaceAll('.', '/') + '.js');
    }
    scripts.push(content(key));
}
visit('js/paste/ui/marquee.js');
fs.writeFileSync(path.join(output, 'example.css'), content('css/marquee.css'));
fs.writeFileSync(path.join(output, 'example.js'), scripts.join('\n;\n') + '\n;paste.require(["paste.ui.marquee"], function (module, marquee) {});\n');
fs.copyFileSync(path.join(root, 'examples/marquee.html'), path.join(output, 'index.html'));
console.log('Standalone example built at ' + path.join(output, 'index.html'));
