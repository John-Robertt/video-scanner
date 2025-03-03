import { promises } from 'fs'
import { relative, join, extname, dirname, parse, isAbsolute } from 'path'
import trash from 'trash'
import { stringify } from 'yaml'
import YAML from 'yaml'

// 文件大小单位转换函数
function parseFileSize(size) {
  const units = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  }

  if (typeof size === 'number') return size

  const match = String(size).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i)
  if (!match) throw new Error('无效的文件大小格式')

  const [, num, unit] = match
  return Math.floor(parseFloat(num) * units[unit.toUpperCase()])
}

// 添加配置选项
const CONFIG = {
  // 默认设置为当前目录
  targetDir: process.cwd(),
  // 新增输出目录配置
  outputDir: '',
  // 默认设置为 10GB
  maxFileSize: '10GB',
  // 最大递归深度
  maxDepth: 10,
  // 跳过隐藏文件
  skipHiddenFiles: true,
  // 测试模式，不实际移动文件
  dryRun: false,
  // 并发处理文件数量
  concurrency: 5,
  // 添加排除目录配置
  excludeDirs: ['node_modules', 'temp', 'downloads', '@eaDir'],
  // 添加安全删除选项(跨设备复制时，删除到回收站)
  useSafeDelete: true,
  // 添加默认文件类型配置
  fileTypes: [
    '.mp4',
    '.avi',
    '.mkv',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.3gp',
    '.ts',
    '.mts',
  ],
}

// 存储操作结果
const results = {
  success: [],
  failed: [],
}

// 添加根目录常量
const ROOT_DIR = process.cwd()

// 优化错误类型枚举
const ErrorTypes = {
  DISK_FULL: 'ENOSPC',
  PERMISSION_DENIED: 'EACCES',
  FILE_BUSY: 'EBUSY',
  FILE_NOT_FOUND: 'ENOENT',
  UNKNOWN: 'UNKNOWN',
}

// 加载配置文件
async function loadConfig() {
  try {
    const configData = await promises.readFile('config/toolsConfig.yml', 'utf8')
    const config = YAML.parse(configData)

    // 使用默认值处理空字段
    const mergedConfig = {
      ...CONFIG,
      ...Object.fromEntries(
        Object.entries(config).map(([key, value]) => {
          // 处理空字符串
          if (value === '') return [key, CONFIG[key]]
          // 处理空数组
          if (Array.isArray(value) && value.length === 0)
            return [key, CONFIG[key]]
          // 处理特定字段的验证
          switch (key) {
            case 'maxFileSize':
              try {
                const size = parseFileSize(String(value))
                if (size > 0 && size <= parseFileSize('100GB')) {
                  return [key, size]
                }
                throw new Error(
                  `maxFileSize 必须在 1B 到 100GB 之间，当前值: ${value}`
                )
              } catch (error) {
                throw new Error(`maxFileSize 格式无效: ${error.message}`)
              }
            case 'maxDepth':
              if (typeof value === 'number' && value >= 0 && value <= 100) {
                return [key, value]
              }
              throw new Error(`maxDepth 必须在 0 到 100 之间，当前值: ${value}`)
            case 'concurrency':
              if (typeof value === 'number' && value > 0 && value <= 20) {
                return [key, value]
              }
              throw new Error(
                `concurrency 必须在 1 到 20 之间，当前值: ${value}`
              )
            case 'fileTypes':
              if (Array.isArray(value)) {
                const validTypes = value.filter(
                  (type) => typeof type === 'string' && type.startsWith('.')
                )
                if (validTypes.length === 0) {
                  console.warn('🔴 fileTypes 格式无效，使用默认值')
                  return [key, CONFIG[key]]
                }
                return [key, validTypes]
              }
              console.warn('🔴 fileTypes 必须是数组，使用默认值')
              return [key, CONFIG[key]]
            case 'excludeDirs':
              if (Array.isArray(value)) {
                const validDirs = value.filter(
                  (dir) => typeof dir === 'string' && dir.trim()
                )
                if (validDirs.length === 0) {
                  console.warn('🔴 excludeDirs 格式无效，使用默认值')
                  return [key, CONFIG[key]]
                }
                return [key, validDirs]
              }
              console.warn('🔴 excludeDirs 必须是数组，使用默认值')
              return [key, CONFIG[key]]
            default:
              return [key, value]
          }
        })
      ),
    }

    // 处理路径配置
    if (mergedConfig.targetDir) {
      try {
        mergedConfig.targetDir = isAbsolute(mergedConfig.targetDir)
          ? mergedConfig.targetDir
          : join(process.cwd(), mergedConfig.targetDir)

        // 验证目标目录是否存在
        if (!(await fileExists(mergedConfig.targetDir))) {
          throw new Error(`目标目录不存在: ${mergedConfig.targetDir}`)
        }
      } catch (error) {
        throw new Error(`目标目录配置无效: ${error.message}`)
      }
    }

    // 处理输出目录配置
    if (mergedConfig.outputDir) {
      try {
        mergedConfig.outputDir =
          mergedConfig.outputDir.startsWith('/') ||
          mergedConfig.outputDir.match(/^[A-Z]:\\/i)
            ? mergedConfig.outputDir
            : join(process.cwd(), mergedConfig.outputDir)

        // 验证输出目录是否存在
        if (!(await fileExists(mergedConfig.outputDir))) {
          throw new Error(`输出目录不存在: ${mergedConfig.outputDir}`)
        }
      } catch (error) {
        throw new Error(`输出目录配置无效: ${error.message}`)
      }
    }

    // 更新全局配置
    Object.assign(CONFIG, mergedConfig)

    console.log('\n📝 已加载配置文件')
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('🔴 未找到配置文件，使用默认配置')
      // 创建默认配置文件
      try {
        const defaultConfig = {
          targetDir: process.cwd(),
          outputDir: '',
          maxFileSize: '10GB',
          maxDepth: 10,
          skipHiddenFiles: true,
          dryRun: false,
          concurrency: 5,
          excludeDirs: ['node_modules', 'temp', 'downloads', '@eaDir'],
          useSafeDelete: true,
          fileTypes: [
            '.mp4',
            '.avi',
            '.mkv',
            '.mov',
            '.wmv',
            '.flv',
            '.webm',
            '.m4v',
            '.mpg',
            '.mpeg',
            '.3gp',
            '.ts',
            '.mts',
          ],
        }

        await promises.writeFile(
          'config.yml',
          stringify(defaultConfig, {
            indent: 2,
            commentString: '#',
          })
        )
      } catch (writeError) {
        console.error('无法创建默认配置文件:', writeError)
      }
    } else {
      console.error('❌ 配置文件验证失败:', error.message)
      process.exit(1)
    }
  }
}

// 增强命令行参数处理
function parseArgs() {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        CONFIG.dryRun = true
        break
    }
  }

  // 优化配置显示
  console.log('\n当前配置:')
  console.log({
    目标目录: relative(process.cwd(), CONFIG.targetDir) || '当前目录',
    最大文件大小: formatFileSize(CONFIG.maxFileSize),
    最大递归深度: CONFIG.maxDepth,
    跳过隐藏文件: CONFIG.skipHiddenFiles ? '是' : '否',
    测试模式: CONFIG.dryRun ? '是' : '否',
    并发处理数: CONFIG.concurrency,
    安全删除: CONFIG.useSafeDelete ? '是' : '否',
    排除目录: CONFIG.excludeDirs.length ? CONFIG.excludeDirs.join(', ') : '无',
    文件类型: CONFIG.fileTypes.length ? CONFIG.fileTypes.join(', ') : '无',
  })
  console.log() // 添加空行
}

async function processDirectory(dirPath, depth = 0) {
  if (depth > CONFIG.maxDepth) {
    console.warn(`🔴 超过最大递归深度 (${CONFIG.maxDepth}): ${dirPath}`)
    return
  }

  // 检查是否为排除目录
  const dirName = parse(dirPath).base
  if (CONFIG.excludeDirs.includes(dirName)) {
    console.log(`⏭️ 跳过排除目录: ${relative(ROOT_DIR, dirPath)}`)
    return
  }

  console.log(`📂 扫描目录: ${relative(ROOT_DIR, dirPath) || '根目录'}`)
  try {
    const items = await promises.readdir(dirPath)
    const videoFiles = []
    const directories = []

    // 分离文件和目录
    for (const item of items) {
      if (CONFIG.skipHiddenFiles && item.startsWith('.')) continue

      const fullPath = join(dirPath, item)
      const stat = await promises.stat(fullPath)

      if (stat.isDirectory()) {
        directories.push(fullPath)
      } else if (
        stat.isFile() &&
        stat.size <= CONFIG.maxFileSize &&
        CONFIG.fileTypes.includes(extname(fullPath).toLowerCase())
      ) {
        videoFiles.push({ path: fullPath, name: item })
      }
    }

    // 并发处理视频文件
    const chunks = chunkArray(videoFiles, CONFIG.concurrency)
    for (const chunk of chunks) {
      await Promise.all(
        chunk.map((file) => moveVideoFile(file.path, file.name))
      )
    }

    // 递归处理子目录
    await Promise.all(
      directories.map((dir) => processDirectory(dir, depth + 1))
    )
  } catch (error) {
    handleError('扫描目录失败', dirPath, error)
  }
}

// 辅助函数：将数组分块
function chunkArray(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

// 添加文件大小格式化函数
function formatFileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`
}

// 优化错误处理函数
function handleError(message, filePath, error) {
  const errorCode = error.code || ErrorTypes.UNKNOWN
  const errorMap = {
    [ErrorTypes.DISK_FULL]: '磁盘空间不足',
    [ErrorTypes.PERMISSION_DENIED]: '权限不足',
    [ErrorTypes.FILE_BUSY]: '文件被占用',
    [ErrorTypes.FILE_NOT_FOUND]: '文件未找到',
    [ErrorTypes.UNKNOWN]: '未知错误',
  }

  const errorMessage = errorMap[errorCode] || error.message
  console.error(`❌ ${message}: ${filePath} - ${errorMessage}`)

  results.failed.push({
    path: filePath,
    error: `[${errorCode}] ${errorMessage}`,
    type: errorCode,
    timestamp: new Date().toISOString(), // 添加时间戳
  })
}

// 添加安全删除函数
async function safeDeleteFile(filePath) {
  if (CONFIG.useSafeDelete) {
    try {
      await trash(filePath)
      return true
    } catch (error) {
      console.warn(`🔴 移动到回收站失败，尝试直接删除: ${filePath}`)
      return false
    }
  }
  return false
}

async function moveVideoFile(sourcePath, fileName) {
  // 确定输出目录
  const outputDirectory = CONFIG.outputDir || CONFIG.targetDir

  if (dirname(sourcePath) === outputDirectory) {
    console.log(`⏭️ 跳过输出目录文件: ${fileName}`)
    return
  }

  try {
    // 检查源文件是否存在
    if (!(await fileExists(sourcePath))) {
      throw { code: ErrorTypes.FILE_NOT_FOUND, message: '源文件不存在' }
    }

    // 如果是测试模式，只打印不执行
    if (CONFIG.dryRun) {
      console.log(`\n🔍 测试模式 - 将移动: ${sourcePath} -> ${outputDirectory}`)
      return
    }

    const targetBase = join(outputDirectory, fileName)
    const { ext, name } = parse(fileName)

    // 处理文件名冲突
    let finalPath = targetBase
    let counter = 1

    // 如果目标文件已存在，则添加数字后缀
    while (await fileExists(finalPath)) {
      const newName = `${name} (${counter})${ext}`
      finalPath = join(outputDirectory, newName)
      counter++
    }

    const sourceStats = await promises.stat(sourcePath)
    const outputStats = await promises.stat(outputDirectory)

    if (sourceStats.dev !== outputStats.dev) {
      console.log(`📝 跨设备复制: ${sourcePath}`)
      await promises.copyFile(sourcePath, finalPath)

      // 使用安全删除
      const safeDeleteSuccess = await safeDeleteFile(sourcePath)
      if (!safeDeleteSuccess) {
        await promises.unlink(sourcePath)
      }
    } else {
      console.log(
        `📝 移动文件: ${sourcePath} (${formatFileSize(sourceStats.size)})`
      )
      await promises.rename(sourcePath, finalPath)
    }

    results.success.push({
      from: sourcePath,
      to: finalPath,
      size: formatFileSize(sourceStats.size),
    })
  } catch (error) {
    handleError('移动文件失败', sourcePath, error)
  }
}

// 辅助函数：检查文件是否存在
async function fileExists(filePath) {
  try {
    await promises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function moveVideoTools() {
  await loadConfig()
  parseArgs()
  console.log('📁 开始处理视频文件...\n')

  if (CONFIG.dryRun) {
    console.log('🔍 测试模式：不会实际移动文件\n')
  }

  // 确保目标目录和输出目录存在
  try {
    await promises.access(CONFIG.targetDir)
    if (CONFIG.outputDir) {
      await promises.access(CONFIG.outputDir)
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(
        `❌ ${CONFIG.outputDir ? '输出' : '目标'}目录不存在: ${error.path}`
      )
      process.exit(1)
    }
    throw error
  }

  const startTime = Date.now()

  try {
    // 使用配置的目标目录替代 ROOT_DIR
    await processDirectory(CONFIG.targetDir)
  } catch (error) {
    console.error('❌ 程序执行出错:', error)
  }

  // 优化结果输出，按错误类型分类
  console.log('\n📊 处理结果统计')
  console.log(`✅ 成功: ${results.success.length} 个文件`)
  console.log(`❌ 失败: ${results.failed.length} 个文件`)

  if (results.failed.length > 0) {
    console.log('\n失败详情:')
    const errorsByType = results.failed.reduce((acc, item) => {
      acc[item.type] = acc[item.type] || []
      acc[item.type].push(item)
      return acc
    }, {})

    for (const [type, errors] of Object.entries(errorsByType)) {
      console.log(`\n${type} (${errors.length} 个文件):`)
      errors.forEach((item) => {
        console.log(`- ${item.path}\n  ${item.error}`)
      })
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  console.log(`\n⏱️ 总耗时: ${duration} 秒`)
}

moveVideoTools().catch((error) => {
  // 执行程序并处理未捕获的错误
  console.error('💥 发生致命错误:', error)
  process.exit(1)
})
