// 项目入口文件
import { Organizer } from './core/organizer.js'
import { logger } from './services/logger.js'
import { config } from './services/config.js'
import { cache } from './services/cache.js'
import fs from 'fs/promises'
import EventEmitter from 'events'

// 增加事件监听器的最大数量限制
EventEmitter.defaultMaxListeners = 20

// 全局变量
let organizer = null
let isCleaningUp = false
let shutdownRequested = false

// 处理未捕获的异常和拒绝的 Promise
process.on('uncaughtException', async (error) => {
  console.error('未捕获的异常:', error)
  await cleanup()
  process.exit(1)
})

process.on('unhandledRejection', async (reason) => {
  console.error('未处理的 Promise 拒绝:', reason)
  await cleanup()
  process.exit(1)
})

/**
 * 处理所有视频文件
 * @returns {Promise<void>}
 */
async function processAllVideos() {
  try {
    // 先加载配置
    await config.load()

    // 确保输出目录存在
    const outputDir = config.get('base.outputDir')
    if (!outputDir) {
      throw new Error('未配置输出目录 (base.outputDir)')
    }
    await fs.mkdir(outputDir, { recursive: true })

    // 初始化日志系统（日志目录会在内部创建）
    await logger.initLogFile()

    // 初始化缓存系统
    await cache.init()

    // 初始化 organizer
    organizer = new Organizer()

    // 设置定期清理缓存的任务
    const cacheCleanupInterval = config.get('cache.cleanupInterval', 3600000) // 默认每小时清理一次
    if (cacheCleanupInterval > 0) {
      const cleanupTimer = setInterval(async () => {
        if (!shutdownRequested) {
          try {
            await cache.cleanup()
          } catch (error) {
            logger.failStep(
              'cache',
              'cleanup',
              `定期清理缓存失败: ${error.message}`
            )
          }
        }
      }, cacheCleanupInterval)

      // 确保清理定时器不阻止程序退出
      cleanupTimer.unref()
    }

    // 直接调用 organizer 处理所有视频
    const results = await organizer.processVideos(config, outputDir)

    // 输出处理结果统计
    const successCount = results.filter((r) => r.success).length
    const failCount = results.filter((r) => !r.success).length
    const totalCount = results.length

    // 确保显示的数量与实际处理的数量一致
    logger.completeStep(
      'main',
      'process',
      `处理完成：成功 ${successCount} 个，失败 ${failCount} 个，总计 ${totalCount} 个`
    )
  } catch (error) {
    logger.failStep('main', 'process', error.message)
    throw error
  }
}

/**
 * 清理资源
 * @returns {Promise<number>} 退出代码
 */
async function cleanup() {
  if (isCleaningUp) {
    logger.startStep('system', 'cleanup', '清理已在进行中...')
    return 0
  }

  isCleaningUp = true
  shutdownRequested = true
  let exitCode = 0

  logger.startStep('system', 'cleanup', '开始清理资源...')

  // 清理 organizer 资源
  try {
    if (organizer) {
      await organizer.cleanup()
    }
  } catch (error) {
    logger.failStep(
      'system',
      'cleanup',
      `清理 organizer 资源时发生错误: ${error.message}`
    )
    exitCode = 1
  }

  // 等待日志写入完成
  try {
    await logger.close()
  } catch (error) {
    console.error('关闭日志时发生错误:', error)
    exitCode = 1
  }

  // 清理旧日志文件
  try {
    await logger.cleanupOldLogs()
  } catch (error) {
    console.error('清理旧日志文件时发生错误:', error)
  }

  logger.completeStep('system', 'cleanup', '清理完成')
  return exitCode
}

// 注册进程退出处理程序
process.on('exit', () => {
  logger.startStep('system', 'exit', '程序正在退出...')
})

process.on('SIGINT', async () => {
  logger.startStep('system', 'exit', '接收到中断信号 (Ctrl+C)')
  const exitCode = await cleanup()
  process.exit(exitCode)
})

process.on('SIGTERM', async () => {
  logger.startStep('system', 'exit', '接收到终止信号')
  const exitCode = await cleanup()
  process.exit(exitCode)
})

// 添加 beforeExit 处理
process.on('beforeExit', async (code) => {
  if (!isCleaningUp) {
    logger.startStep('system', 'exit', '程序即将退出，执行最终清理...')
    const exitCode = await cleanup()
    process.exitCode = exitCode || code
  }
})

/**
 * 主函数
 */
async function main() {
  let exitCode = 0

  try {
    await processAllVideos()
  } catch (error) {
    console.error('处理视频时发生错误:', error)
    exitCode = 1
  } finally {
    // 执行清理
    const cleanupExitCode = await cleanup()

    // 如果清理过程出错，使用清理的退出码
    if (cleanupExitCode !== 0) {
      exitCode = cleanupExitCode
    }

    // 设置进程退出码
    process.exitCode = exitCode
  }
}

// 启动处理
main().catch((error) => {
  console.error('程序执行失败:', error)
  process.exit(1)
})
