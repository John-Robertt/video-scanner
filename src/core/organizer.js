// 处理文件整理和归类
import path from 'path'
import fs from 'fs/promises'
import { scraper } from './scraper.js'
import { images } from '../utils/images.js'
import { nfo } from '../services/nfo.js'
import { logger } from '../services/logger.js'
import { scanner } from './scanner.js'
import { fileUtils } from '../utils/fileUtils.js'
import { taskQueue } from './queue.js'
import { cache } from '../services/cache.js'
import { createRetryableFunction } from '../utils/retry.js'

export class Organizer {
  constructor() {
    this.initCache()
    this.cleanupTimer = null

    // 使用新的重试机制创建可重试的方法
    this.generateNfoFile = createRetryableFunction(
      this._generateNfoFile.bind(this),
      {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 5000,
        stepId: 'nfo-generation',
      }
    )

    this.moveVideoFile = createRetryableFunction(
      this._moveVideoFile.bind(this),
      {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 5000,
        stepId: 'file-move',
      }
    )
  }

  async initCache() {
    await cache.init()
  }

  async cleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    await cache.cleanup()
  }

  // 预编译的正则表达式
  static VIDEO_CODE_PATTERNS = {
    FC2: /FC2[^\d]*(\d+)/i,
    STANDARD: /([A-Z]{2,6})-(\d{2,5})(?:-[A-Z])?/i,
    NO_HYPHEN: /([A-Z]{2,6})(\d{2,5})(?:-[A-Z])?/i,
  }

  /**
   * 从文件名中提取视频编号
   * @param {string} fileName 文件名
   * @returns {string} 视频编号
   */
  extractVideoCode(fileName) {
    // 获取不带扩展名的文件名
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '')

    // 按优先级尝试不同的匹配模式
    const patterns = [
      {
        regex: Organizer.VIDEO_CODE_PATTERNS.FC2,
        format: (match) => `FC2-PPV-${match[1]}`,
      },
      {
        regex: Organizer.VIDEO_CODE_PATTERNS.STANDARD,
        format: (match) => `${match[1]}-${match[2]}`,
      },
      {
        regex: Organizer.VIDEO_CODE_PATTERNS.NO_HYPHEN,
        format: (match) => `${match[1]}-${match[2]}`,
      },
    ]

    // 尝试每种匹配模式
    for (const pattern of patterns) {
      const match = nameWithoutExt.match(pattern.regex)
      if (match) {
        return pattern.format(match).toUpperCase()
      }
    }

    // 如果都没匹配到，返回原文件名（不含扩展名）
    return nameWithoutExt
  }

  /**
   * 生成NFO文件
   * @param {string} videoCode 视频编号
   * @param {Object} metadata 视频元数据
   * @param {string} videoDir 视频目录
   * @returns {Promise<string>} NFO文件路径
   * @private
   */
  async _generateNfoFile(videoCode, metadata, videoDir) {
    logger.startStep(videoCode, 'nfo', '正在生成NFO文件')
    const nfoPath = path.join(videoDir, `${metadata.code}.nfo`)
    await nfo.generateNfo(metadata, nfoPath)
    logger.completeStep(videoCode, 'nfo', '成功生成NFO文件')
    return nfoPath
  }

  /**
   * 移动视频文件
   * @param {string} videoCode 视频编号
   * @param {string} sourceVideoPath 源视频路径
   * @param {string} videoDir 目标目录
   * @returns {Promise<Object>} 移动结果
   * @private
   */
  async _moveVideoFile(videoCode, sourceVideoPath, videoDir) {
    logger.startStep(videoCode, 'move', '正在移动视频文件')
    const moveResult = await fileUtils.moveFile(sourceVideoPath, videoDir, {
      useSafeDelete: true,
      overwrite: false,
    })
    if (!moveResult.success) {
      throw new Error(`移动视频文件失败: ${moveResult.error}`)
    }
    logger.completeStep(videoCode, 'move', '成功移动视频文件')
    return moveResult
  }

  /**
   * 处理视频文件
   * @param {Object} videoInfo 视频信息对象
   * @param {Object} config 配置对象
   * @param {string} targetDir 目标目录
   */
  async processVideo(videoInfo, config, targetDir) {
    const { code: videoCode, file: videoFile } = videoInfo
    const sourceVideoPath = videoFile.path
    let metadata = null
    let videoDir = null

    try {
      // 尝试从缓存获取metadata
      metadata = await cache.get(`metadata:${videoCode}`)

      if (!metadata) {
        logger.startStep(videoCode, 'scan', `正在处理视频文件 ${videoCode}`)
        logger.completeStep(
          videoCode,
          'scan',
          `找到视频文件: ${sourceVideoPath}`
        )

        logger.startStep(
          videoCode,
          'scrape',
          `正在获取视频 ${videoCode} 的信息`
        )
        metadata = await scraper.javdb.getVideoInfo(videoCode, config)
        logger.completeStep(
          videoCode,
          'scrape',
          `成功获取视频 ${videoCode} 的信息`
        )

        // 缓存metadata，有效期24小时
        await cache.set(`metadata:${videoCode}`, metadata)
      } else {
        logger.completeStep(
          videoCode,
          'cache',
          `从缓存获取到视频 ${videoCode} 的信息`
        )
      }

      // 如果目录不存在才创建
      logger.startStep(videoCode, 'createDir', '正在创建视频目录')
      videoDir = path.join(targetDir, metadata.code)
      await fs.mkdir(videoDir, { recursive: true })
      logger.completeStep(videoCode, 'createDir', `成功创建目录: ${videoDir}`)

      try {
        // 生成 NFO 文件
        await this.generateNfoFile(videoCode, metadata, videoDir)

        // 下载并保存封面图片
        logger.startStep(videoCode, 'covers', '正在下载封面图片')
        await images.downloadAndSaveCovers(metadata.coverUrl, videoDir, {
          taskId: videoCode,
          rightHalf: true,
        })
        logger.completeStep(videoCode, 'covers', '成功下载并处理封面图片')

        // 移动视频文件
        await this.moveVideoFile(videoCode, sourceVideoPath, videoDir)

        // 使用代理池后无需等待
        // 处理完成后等待3秒
        // await new Promise((resolve) => setTimeout(resolve, 3000))

        return {
          success: true,
          code: metadata.code,
          path: videoDir,
        }
      } catch (error) {
        // 如果在处理NFO或封面时出错，检查并恢复视频文件
        if (videoDir) {
          try {
            // 检查视频文件是否在目标目录中
            const videoFiles = await fs.readdir(videoDir)
            const videoFile = videoFiles.find((file) =>
              config
                .get('fileTypes.video')
                .includes(path.extname(file).toLowerCase())
            )

            if (videoFile) {
              // 如果找到视频文件，将其移回原位置
              const currentVideoPath = path.join(videoDir, videoFile)
              await fileUtils.moveFile(
                currentVideoPath,
                path.dirname(sourceVideoPath),
                {
                  useSafeDelete: false,
                  overwrite: false,
                  newName: path.basename(sourceVideoPath),
                }
              )
            }

            // 删除临时目录
            await fs.rm(videoDir, { recursive: true, force: true })
          } catch (cleanupError) {
            console.error('清理临时文件时出错:', cleanupError)
          }
        }
        throw error
      }
    } catch (error) {
      return {
        success: false,
        code: videoInfo.code,
        error: error.message,
      }
    }
  }

  /**
   * 批量处理视频文件
   * @param {Object} config 配置对象
   * @param {string} targetDir 目标目录
   */
  async processVideos(config, targetDir) {
    try {
      // 启动定时清理
      this.cleanupTimer = setInterval(() => cache.cleanup(), 6 * 60 * 60 * 1000)

      const videoFiles = await scanner.getVideoFiles(config)
      const totalVideoCount = videoFiles.length
      logger.startStep('batch', 'scan', `找到 ${totalVideoCount} 个视频文件`)

      const videoInfos = videoFiles.map((file) => ({
        code: this.extractVideoCode(file.name),
        file: file,
      }))

      logger.startStep(
        'batch',
        'process',
        `开始批量处理 ${totalVideoCount} 个视频文件`
      )

      // 使用任务队列处理视频
      const tasks = videoInfos.map((videoInfo) => async () => {
        logger.startStep(
          'batch',
          videoInfo.code,
          `开始处理视频 ${videoInfo.code}`
        )
        const result = await this.processVideo(videoInfo, config, targetDir)

        if (result.success) {
          logger.completeStep(
            'batch',
            videoInfo.code,
            `视频 ${videoInfo.code} 处理成功`
          )
        } else {
          logger.failStep(
            'batch',
            videoInfo.code,
            `视频 ${videoInfo.code} 处理失败: ${result.error}`
          )
        }

        return result
      })

      // 监听任务完成事件以输出进度
      taskQueue.on('taskComplete', () => {
        const stats = taskQueue.getStats()
        const total = totalVideoCount // 使用实际扫描到的视频文件总数
        const progress = ((stats.completed / total) * 100).toFixed(1)
        logger.completeStep(
          'batch',
          'progress',
          `处理进度: ${progress}% (${stats.completed}/${total})`
        )
      })

      const results = await taskQueue.processAll(tasks)

      // 最后再输出一次完整的进度信息
      const finalStats = taskQueue.getStats()
      const finalProgress = (
        (finalStats.completed / totalVideoCount) *
        100
      ).toFixed(1)
      logger.completeStep(
        'batch',
        'progress',
        `最终处理进度: ${finalProgress}% (${finalStats.completed}/${totalVideoCount})`
      )

      // 清理资源
      taskQueue.clear()
      await this.cleanup()

      return results
    } catch (error) {
      logger.failStep('batch', 'process', `批量处理失败: ${error.message}`)
      await this.cleanup()
      throw error
    }
  }
}
