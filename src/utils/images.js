import fsPromises from 'fs/promises'
import sharp from 'sharp'
import path from 'path'
import axios from 'axios'
import { logger } from '../services/logger.js'
import { createRetryableFunction } from './retry.js'
import fs from 'fs'

export class Images {
  /**
   * 初始化图片处理类
   * @param {Object} options 配置选项
   * @param {number} options.timeout 请求超时时间(ms)
   * @param {string} options.userAgent 用户代理字符串
   */
  constructor(options = {}) {
    // 创建专用的 axios 实例
    this.client = axios.create({
      timeout: options.timeout || 30000,
      headers: {
        'User-Agent':
          options.userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    })

    // 使用新的重试机制创建可重试的方法
    this.downloadImage = createRetryableFunction(
      this._downloadImage.bind(this),
      {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000,
        stepId: 'download-image',
      }
    )

    this.processAndSaveImages = createRetryableFunction(
      this._processAndSaveImages.bind(this),
      {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000,
        stepId: 'process-image',
      }
    )
  }

  /**
   * 分割封面图片
   * @param {Buffer} imageBuffer 图片的Buffer
   * @param {Object} options 分割选项
   * @param {string} options.taskId 任务ID，用于日志
   * @param {boolean} options.rightHalf 是否裁剪右半部分，默认为true
   * @returns {Promise<Buffer>} 分割后的图片
   * @throws {Error} 当图片处理失败时抛出错误
   */
  async splitCoverImage(imageBuffer, options = {}) {
    if (!imageBuffer || !(imageBuffer instanceof Buffer)) {
      throw new Error('无效的图片数据：必须提供有效的Buffer')
    }

    const taskId = options.taskId || 'image'
    const rightHalf = options.rightHalf !== false

    try {
      logger.startStep(taskId, 'split', '开始处理封面图片')
      const image = sharp(imageBuffer)
      const metadata = await image.metadata()

      if (!metadata || !metadata.width || !metadata.height) {
        throw new Error('无法获取图片尺寸信息')
      }

      const { width, height } = metadata

      // 处理奇数宽度
      const halfWidth = Math.ceil(width / 2)

      // 根据选项裁剪左半部分或右半部分
      const extractOptions = rightHalf
        ? {
            left: halfWidth,
            top: 0,
            width: width - halfWidth,
            height,
          }
        : {
            left: 0,
            top: 0,
            width: halfWidth,
            height,
          }

      const processedImage = await image.extract(extractOptions).toBuffer()
      logger.completeStep(
        taskId,
        'split',
        `封面处理完成，裁剪${rightHalf ? '右' : '左'}半部分`
      )
      return processedImage
    } catch (error) {
      logger.failStep(taskId, 'error', `处理封面图片失败: ${error.message}`)
      throw error
    }
  }

  /**
   * 下载图片
   * @param {string} imageUrl 图片URL
   * @param {Object} options 下载选项
   * @returns {Promise<Buffer>} 图片Buffer
   * @private
   */
  async _downloadImage(taskId, imageUrl, options = {}) {
    logger.startStep(taskId, 'download', `开始下载封面: ${imageUrl}`)

    const { timeout = 30000 } = options

    const coverResponse = await this.client.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: timeout,
    })

    if (!coverResponse?.data) {
      throw new Error('下载封面失败：响应数据为空')
    }

    const imageBuffer = Buffer.from(coverResponse.data)
    logger.completeStep(taskId, 'download', '封面下载完成')

    return imageBuffer
  }

  /**
   * 处理并保存图片
   * @param {Buffer} imageBuffer 图片Buffer
   * @param {string} outputDir 输出目录
   * @param {Object} options 处理选项
   * @returns {Promise<Object>} 处理结果
   * @private
   */
  async _processAndSaveImages(taskId, imageBuffer, outputDir, options = {}) {
    const {
      rightHalf = true,
      fanartName = 'fanart',
      posterName = 'poster',
    } = options

    // 从URL中获取原始图片扩展名
    const extension = options.extension || '.jpg'
    const fanartPath = path.join(outputDir, `${fanartName}${extension}`)
    const posterPath = path.join(outputDir, `${posterName}${extension}`)

    // 保存原始封面
    logger.startStep(taskId, 'fanart', '开始保存原始封面')
    await fsPromises.writeFile(fanartPath, imageBuffer)
    logger.completeStep(taskId, 'fanart', `原始封面已保存: ${fanartPath}`)

    // 处理并保存海报
    logger.startStep(taskId, 'poster', '开始处理海报图片')
    const splitCoverBuffer = await this.splitCoverImage(imageBuffer, {
      taskId,
      rightHalf,
    })
    await fsPromises.writeFile(posterPath, splitCoverBuffer)
    logger.completeStep(taskId, 'poster', `海报已保存: ${posterPath}`)

    return {
      success: true,
      fanartPath,
      posterPath,
    }
  }

  /**
   * 下载并保存封面图片
   * @param {string} coverUrl 封面图片URL
   * @param {string} outputDir 输出目录
   * @param {Object} options 配置选项
   * @param {number} options.retryCount 重试次数
   * @param {number} options.timeout 下载超时时间(ms)
   * @param {boolean} options.rightHalf 是否裁剪右半部分，默认为true
   * @param {string} options.fanartName 原始封面文件名，默认为'fanart'
   * @param {string} options.posterName 海报文件名，默认为'poster'
   * @returns {Promise<Object>} 包含文件路径的结果对象
   * @throws {Error} 当参数无效或处理失败时抛出错误
   */
  async downloadAndSaveCovers(coverUrl, outputDir, options = {}) {
    // 参数验证
    if (!coverUrl?.startsWith('http')) {
      throw new Error('无效的封面图片URL')
    }

    if (!outputDir) {
      throw new Error('必须提供输出目录')
    }

    // 确保输出目录存在
    try {
      await fsPromises.access(outputDir, fs.constants.W_OK)
    } catch (error) {
      throw new Error(`输出目录不存在或无写入权限: ${error.message}`)
    }

    const { timeout = 30000, taskId = 'image' } = options

    try {
      // 从URL中获取原始图片扩展名
      const extension = path.extname(new URL(coverUrl).pathname) || '.jpg'

      // 下载图片
      const imageBuffer = await this.downloadImage(taskId, coverUrl, {
        timeout,
      })

      // 处理并保存图片
      return await this.processAndSaveImages(taskId, imageBuffer, outputDir, {
        ...options,
        extension,
      })
    } catch (error) {
      logger.failStep(taskId, 'process', `处理封面图片失败: ${error.message}`)
      throw error
    }
  }
}

/**
 * 创建默认的图片处理实例
 */
export const images = new Images()

// images.downloadAndSaveCovers(
//   'https://pics.dmm.co.jp/mono/movie/adult/wanz921/wanz921pl.jpg',
//   'Z:/HC550-3/Download/output/UMSO-529',
//   {
//     taskId: '111',
//     rightHalf: true,
//   }
// )
