import {
  exportsGlob,
  getCodeFormat,
  getFilePathFormat,
  getCodeFormatExtension,
  isExplicitExtension,
  createPromiseQueue
} from './utils.js'

/**
 * Includes internal _include that used to filter paths that is packed.
 * Mainly for node.js local usage only. So that we lint files that are packed only.
 * Currently only used if pkg has no `exports`
 * @typedef {Required<import('..').Options> & {
 *   _packedFiles?: string[]
 * }} Options
 */

/**
 * @param {Options} options
 * @returns {Promise<import('..').Message[]>}
 */
export async function publint({ pkgDir, vfs, level, _packedFiles }) {
  /** @type {import('..').Message[]} */
  const messages = []
  /**
   * A promise queue is created to run all linting tasks in parallel
   */
  const promiseQueue = createPromiseQueue()

  const rootPkgPath = vfs.pathJoin(pkgDir, 'package.json')
  const rootPkgContent = await readFile(rootPkgPath, [])
  if (rootPkgContent === false) return messages
  const rootPkg = JSON.parse(rootPkgContent)
  const { main, module, exports, browser } = rootPkg

  /**
   * @param {string} filePath
   */
  function isPathLintable(filePath) {
    return (
      filePath.endsWith('.js') ||
      filePath.endsWith('.mjs') ||
      filePath.endsWith('.cjs')
    )
  }

  /**
   * @param {string} path
   * @param {string[]} pkgPath
   * @param {string[]} tryExtensions
   * @returns {Promise<string | false>}
   */
  async function readFile(path, pkgPath, tryExtensions = []) {
    try {
      const content = await vfs.readFile(path)
      if (_packedFiles && !_packedFiles.includes(path)) {
        fileNotPublished(pkgPath)
      }
      return content
    } catch {
      for (const ext of tryExtensions) {
        try {
          const content = await vfs.readFile(path + ext)
          if (_packedFiles && !_packedFiles.includes(path)) {
            fileNotPublished(pkgPath)
          }
          return content
        } catch {}
      }
      messages.push({
        code: 'FILE_DOES_NOT_EXIST',
        args: { filePath: path },
        path: pkgPath,
        type: 'error'
      })
      return false
    }
  }

  /**
   * @param {string[]} pkgPath
   */
  function fileNotPublished(pkgPath) {
    messages.push({
      code: 'FILE_NOT_PUBLISHED',
      args: {},
      path: pkgPath,
      type: 'error'
    })
  }

  // Relies on default node resolution
  // https://nodejs.org/api/modules.html#all-together
  // LOAD_INDEX(X)
  if (!main && !module && !exports) {
    promiseQueue.push(async () => {
      // check index.js only, others aren't our problem
      const defaultPath = vfs.pathJoin(pkgDir, 'index.js')
      if (await vfs.isPathExist(defaultPath)) {
        const defaultContent = await readFile(defaultPath, [])
        if (defaultContent === false) return
        const actualFormat = getCodeFormat(defaultContent)
        const expectFormat = await getFilePathFormat(defaultPath, vfs)
        if (
          actualFormat !== expectFormat &&
          actualFormat !== 'unknown' &&
          actualFormat !== 'mixed'
        ) {
          messages.push({
            code: 'IMPLICIT_INDEX_JS_INVALID_FORMAT',
            args: {
              actualFormat,
              expectFormat
            },
            path: ['name'],
            type: 'warning'
          })
        }
      }
    })
  }

  /**
   * Rules for main:
   * - It's mostly used for CJS
   * - It can be used for ESM, but if you're doing so, might as well use exports
   */
  if (main) {
    promiseQueue.push(async () => {
      const mainPath = vfs.pathJoin(pkgDir, main)
      const mainContent = await readFile(
        mainPath,
        ['main'],
        ['.js', '/index.js']
      )
      if (mainContent === false) return
      const actualFormat = getCodeFormat(mainContent)
      const expectFormat = await getFilePathFormat(mainPath, vfs)
      if (
        actualFormat !== expectFormat &&
        actualFormat !== 'unknown' &&
        actualFormat !== 'mixed'
      ) {
        const actualExtension = vfs.getExtName(mainPath)
        messages.push({
          code: isExplicitExtension(actualExtension)
            ? 'FILE_INVALID_EXPLICIT_FORMAT'
            : 'FILE_INVALID_FORMAT',
          args: {
            actualFormat,
            expectFormat,
            actualExtension,
            expectExtension: getCodeFormatExtension(actualFormat)
          },
          path: ['main'],
          type: 'warning'
        })
      }
      if (expectFormat === 'ESM' && !exports) {
        messages.push({
          code: 'HAS_ESM_MAIN_BUT_NO_EXPORTS',
          args: {},
          path: ['main'],
          type: 'suggestion'
        })
      }
    })
  }

  /**
   * Rules for module:
   * - Bundler-specific
   * - Is not a way to support dual packages in NodeJS
   * - Should be MJS always!!
   */
  if (module) {
    promiseQueue.push(async () => {
      const modulePath = vfs.pathJoin(pkgDir, module)
      const moduleContent = await readFile(
        modulePath,
        ['module'],
        ['.js', '/index.js']
      )
      if (moduleContent === false) return
      const actualFormat = getCodeFormat(moduleContent)
      if (actualFormat === 'CJS') {
        messages.push({
          code: 'MODULE_SHOULD_BE_ESM',
          args: {},
          path: ['module'],
          type: 'error'
        })
      }
      // TODO: Check valid content too?
      if (!exports) {
        messages.push({
          code: 'HAS_MODULE_BUT_NO_EXPORTS',
          args: {},
          path: ['module'],
          type: 'suggestion'
        })
      }
    })
  }

  // check file existence for other known package fields
  const knownFields = ['types', 'jsnext:main', 'jsnext', 'unpkg', 'jsdelivr']
  for (const field of knownFields) {
    if (typeof rootPkg[field] === 'string') {
      promiseQueue.push(async () => {
        const fieldPath = vfs.pathJoin(pkgDir, rootPkg[field])
        await readFile(fieldPath, [field], ['.js', '/index.js'])
      })
    }
  }

  // check file existence for browser field
  if (browser) {
    crawlBrowser(browser)
    // if the package has both the `browser` and `exports` fields, recommend to use
    // the browser condition instead
    if (exports) {
      messages.push({
        code: 'USE_EXPORTS_BROWSER',
        args: {},
        path: ['browser'],
        type: 'suggestion'
      })
    }
  }

  if (exports) {
    // recursively check exports
    crawlExports(exports)
  } else {
    // all files can be accessed. verify them all
    promiseQueue.push(async () => {
      const files = await exportsGlob(
        vfs.pathJoin(pkgDir, './*'),
        vfs,
        _packedFiles
      )
      const pq = createPromiseQueue()
      for (const filePath of files) {
        if (!isPathLintable(filePath)) continue
        pq.push(async () => {
          const fileContent = await readFile(filePath, [])
          if (fileContent === false) return
          const actualFormat = getCodeFormat(fileContent)
          const expectFormat = await getFilePathFormat(filePath, vfs)
          if (
            actualFormat !== expectFormat &&
            actualFormat !== 'unknown' &&
            actualFormat !== 'mixed'
          ) {
            // special case where if the file path contains the keyword "browser" or
            // "bundler", but it has problems. allow skipping the problem if it's ESM.
            const isSafeEsm =
              actualFormat === 'ESM' &&
              (filePath.includes('browser') || filePath.includes('bundler'))
            if (isSafeEsm) return

            const actualExtension = vfs.getExtName(filePath)
            messages.push({
              code: isExplicitExtension(actualExtension)
                ? 'FILE_INVALID_EXPLICIT_FORMAT'
                : 'FILE_INVALID_FORMAT',
              args: {
                actualFormat,
                expectFormat,
                actualExtension,
                expectExtension: getCodeFormatExtension(actualFormat),
                actualFilePath: '/' + vfs.pathRelative(pkgDir, filePath)
              },
              path: ['name'],
              type: 'warning'
            })
          }
        })
      }
      await pq.wait()
    })
  }

  await promiseQueue.wait()

  if (level === 'warning') {
    return messages.filter((m) => m.type !== 'suggestion')
  } else if (level === 'error') {
    return messages.filter((m) => m.type === 'error')
  }

  return messages

  /**
   * @param {string | Record<string, any>} fieldValue
   * @param {string[]} currentPath
   */
  function crawlBrowser(fieldValue, currentPath = ['browser']) {
    if (typeof fieldValue === 'string') {
      promiseQueue.push(async () => {
        const browserPath = vfs.pathJoin(pkgDir, fieldValue)
        await readFile(browserPath, currentPath)
      })
    } else if (typeof fieldValue === 'object') {
      for (const key in fieldValue) {
        crawlBrowser(fieldValue[key], currentPath.concat(key))
      }
    }
  }

  /**
   * @param {string} exports
   */
  async function getExportsFiles(exports) {
    const exportsPath = vfs.pathJoin(pkgDir, exports)
    const isGlob = exports.includes('*')
    return isGlob ? await exportsGlob(exportsPath, vfs) : [exportsPath]
  }

  function crawlExports(
    exports,
    currentPath = ['exports'],
    isAfterNodeCondition = false
  ) {
    if (typeof exports === 'string') {
      promiseQueue.push(async () => {
        // warn deprecated subpath mapping
        // https://nodejs.org/docs/latest-v16.x/api/packages.html#subpath-folder-mappings
        if (exports.endsWith('/')) {
          const expectPath = currentPath.map((part) => {
            return part.endsWith('/') ? part + '*' : part
          })
          messages.push({
            code: 'EXPORTS_GLOB_NO_DEPRECATED_SUBPATH_MAPPING',
            args: {
              expectPath,
              expectValue: exports + '*'
            },
            path: currentPath,
            type: 'warning'
          })
          // Help fix glob so we can further analyze other issues
          exports += '*'
        }

        // error incorrect exports value
        if (!exports.startsWith('./')) {
          messages.push({
            code: 'EXPORTS_VALUE_INVALID',
            args: {
              suggestValue: './' + exports.replace(/^[\/]+/, '')
            },
            path: currentPath,
            type: 'error'
          })
        }

        const isGlob = exports.includes('*')
        const exportsFiles = await getExportsFiles(exports)

        if (isGlob && !exportsFiles.length) {
          messages.push({
            code: 'EXPORTS_GLOB_NO_MATCHED_FILES',
            args: {},
            path: currentPath,
            type: 'warning'
          })
          return
        }

        // types. check file existence only
        if (currentPath.includes('types')) {
          const pq = createPromiseQueue()
          for (const filePath of exportsFiles) {
            pq.push(async () => await readFile(filePath, currentPath))
          }
          await pq.wait()
          return
        }

        const pq = createPromiseQueue()

        // TODO: group glob warnings
        for (const filePath of exportsFiles) {
          // TODO: maybe check .ts in the future
          if (!isPathLintable(filePath)) continue
          pq.push(async () => {
            // could fail if in !isGlob
            const fileContent = await readFile(filePath, currentPath)
            if (fileContent === false) return
            // the `module` condition is only used by bundlers and must be ESM
            if (currentPath.includes('module')) {
              const actualFormat = getCodeFormat(fileContent)
              if (actualFormat === 'CJS') {
                messages.push({
                  code: 'EXPORTS_MODULE_SHOULD_BE_ESM',
                  args: {},
                  path: currentPath,
                  type: 'error'
                })
              }
              return
            }
            // file format checks isn't required for `browser` condition or exports
            // after the node condtion, as nodejs doesn't use it, only bundlers do,
            // which doesn't care of the format
            if (isAfterNodeCondition || currentPath.includes('browser')) return
            const actualFormat = getCodeFormat(fileContent)
            const expectFormat = await getFilePathFormat(filePath, vfs)
            if (
              actualFormat !== expectFormat &&
              actualFormat !== 'unknown' &&
              actualFormat !== 'mixed'
            ) {
              // special case where if the file path contains the keyword "browser" or
              // "bundler", but it has problems. allow skipping the problem if it's ESM.
              const isSafeEsm =
                actualFormat === 'ESM' &&
                (filePath.includes('browser') || filePath.includes('bundler'))
              if (isSafeEsm) return

              const actualExtension = vfs.getExtName(filePath)
              messages.push({
                code: isExplicitExtension(actualExtension)
                  ? 'FILE_INVALID_EXPLICIT_FORMAT'
                  : 'FILE_INVALID_FORMAT',
                args: {
                  actualFormat,
                  expectFormat,
                  actualExtension,
                  expectExtension: getCodeFormatExtension(actualFormat),
                  actualFilePath: isGlob
                    ? './' + vfs.pathRelative(pkgDir, filePath)
                    : exports
                },
                path: currentPath,
                type: 'warning'
              })
            }
          })
        }

        await pq.wait()
      })
    }
    // `exports` could be null to disallow exports of globs from another key
    else if (exports) {
      const exportsKeys = Object.keys(exports)

      // the types export should be the first condition
      if ('types' in exports && exportsKeys[0] !== 'types') {
        messages.push({
          code: 'EXPORTS_TYPES_SHOULD_BE_FIRST',
          args: {},
          path: currentPath.concat('types'),
          type: 'error'
        })
      }

      // the default export should be the last condition
      if (
        'default' in exports &&
        exportsKeys[exportsKeys.length - 1] !== 'default'
      ) {
        messages.push({
          code: 'EXPORTS_DEFAULT_SHOULD_BE_LAST',
          args: {},
          path: currentPath.concat('default'),
          type: 'error'
        })
      }

      // keep special state of whether the next `crawlExports` iterations are after a node condition.
      // if there are, we can skip code format check as nodejs doesn't touch them, except bundlers
      // which are fine with any format.
      let isKeyAfterNodeCondition = isAfterNodeCondition
      for (const key of exportsKeys) {
        crawlExports(
          exports[key],
          currentPath.concat(key),
          isKeyAfterNodeCondition
        )
        if (key === 'node') {
          isKeyAfterNodeCondition = true
        }
      }
    }
  }
}
