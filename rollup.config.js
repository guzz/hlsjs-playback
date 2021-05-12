import commonjs from '@rollup/plugin-commonjs'
import resolve from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import babel from '@rollup/plugin-babel'
import filesize from 'rollup-plugin-filesize'
import livereload from 'rollup-plugin-livereload'
import serve from 'rollup-plugin-serve'
import size from 'rollup-plugin-sizes'
import { terser } from 'rollup-plugin-terser'
import visualize from 'rollup-plugin-visualizer'
import { version as clapprCoreVersion } from '@guzzj/clappr-core/package.json'
import pkg from './package.json'

let rollupConfig

const serveLocal = !!process.env.SERVE
const reloadEnabled = !!process.env.RELOAD
const analyzeBundle = !!process.env.ANALYZE_BUNDLE
const minimize = !!process.env.MINIMIZE

const babelOptionsPlugins = { exclude: 'node_modules/**', babelHelpers: 'bundled' }
const servePluginOptions = { contentBase: ['dist', 'public'], host: '0.0.0.0', port: '8080' }
const livereloadPluginOptions = { watch: ['dist', 'public'] }
const baseReplacePluginOptions = { CLAPPR_CORE_VERSION: JSON.stringify(clapprCoreVersion) }
const replacePluginOptions = { ...baseReplacePluginOptions, 'process.env.NODE_ENV': JSON.stringify('development') }

let plugins = [
  replace(baseReplacePluginOptions),
  resolve(),
  commonjs(),
  babel(babelOptionsPlugins),
  size(),
  filesize(),
]

serveLocal && (plugins = [...plugins, replace(replacePluginOptions), serve(servePluginOptions)])
reloadEnabled && (plugins = [...plugins, livereload(livereloadPluginOptions)])
analyzeBundle && plugins.push(visualize({ open: true }))

const mainBundle = {
  external: ['@guzzj/clappr-core'],
  input: 'src/hls.js',
  output: {
    name: 'HlsjsPlayback',
    file: pkg.main,
    format: 'umd',
    globals: { '@guzzj/clappr-core': 'Clappr' },
  },
  plugins,
}

const mainBundleWithoutHLS = {
  external: ['@guzzj/clappr-core', 'hls.js'],
  input: 'src/hls.js',
  output: {
    name: 'HlsjsPlayback',
    file: 'dist/hlsjs-playback.external.js',
    format: 'umd',
    globals: { '@guzzj/clappr-core': 'Clappr', 'hls.js': 'Hls' },
  },
  plugins,
}

const mainBundleMinified = {
  input: 'src/hls.js',
  output: {
    name: 'HlsjsPlayback',
    file: 'dist/hlsjs-playback.min.js',
    format: 'iife',
    sourcemap: true,
    plugins: terser(),
  },
  plugins,
}

const mainBundleWithoutHLSMinified = {
  external: ['@guzzj/clappr-core', 'hls.js'],
  input: 'src/hls.js',
  output: {
    name: 'HlsjsPlayback',
    file: 'dist/hlsjs-playback.external.min.js',
    globals: { '@guzzj/clappr-core': 'Clappr', 'hls.js': 'Hls' },
    format: 'iife',
    sourcemap: true,
    plugins: terser(),
  },
  plugins,
}

const moduleBundle = {
  external: ['@guzzj/clappr-core'],
  input: 'src/hls.js',
  output: {
    name: 'HlsjsPlayback',
    file: pkg.module,
    format: 'esm',
    globals: { '@guzzj/clappr-core': 'Clappr' },
  },
  plugins,
}

rollupConfig = [mainBundle, mainBundleWithoutHLS, moduleBundle]
serveLocal && (rollupConfig = [mainBundle, mainBundleWithoutHLS])
minimize && rollupConfig.push(mainBundleMinified, mainBundleWithoutHLSMinified)

export default rollupConfig
