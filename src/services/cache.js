import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { config } from './config.js'

class Cache {
  constructor() {
    // 使用 Map 实现简单的 LRU 缓存
    this.memoryCache = new Map()
    this.accessOrder = [] // 用于跟踪访问顺序
    this.cacheDir = null
    this.maxMemoryItems = null
    this.maxFileAge = null
    this.initialized = false
    this.initPromise = null
  }

  async init() {
    // 避免重复初始化，使用 Promise 防止并发初始化
    if (this.initialized) {
      return
    }

    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this._doInit()
    return this.initPromise
  }

  async _doInit() {
    try {
      // 确保配置已加载
      if (!config.config) {
        await config.load()
      }

      // 获取配置项
      this.maxMemoryItems = config.get('cache.maxMemoryItems', 1000)
      this.maxFileAge = config.get('cache.maxAge', 24 * 60 * 60 * 1000)

      // 处理缓存目录路径
      const configCacheDir = config.get('cache.dir', '.cache')
      const baseDir = path.dirname(config.get('base.outputDir'))
      this.cacheDir = path.resolve(baseDir, configCacheDir)

      // 创建缓存目录
      await fs.mkdir(this.cacheDir, { recursive: true })

      this.initialized = true
    } catch (error) {
      console.error('初始化缓存失败:', error)
      throw error
    } finally {
      this.initPromise = null
    }
  }

  generateKey(key) {
    return crypto.createHash('md5').update(JSON.stringify(key)).digest('hex')
  }

  async get(key, options = {}) {
    if (!this.initialized) {
      await this.init()
    }

    const cacheKey = this.generateKey(key)

    // 先检查内存缓存
    if (this.memoryCache.has(cacheKey)) {
      const item = this.memoryCache.get(cacheKey)
      if (!this.isExpired(item, item.maxAge || options.maxAge)) {
        // 更新访问顺序
        this.updateAccessOrder(cacheKey)
        return item.data
      }
      this.memoryCache.delete(cacheKey)
      this.removeFromAccessOrder(cacheKey)
    }

    // 检查文件缓存
    try {
      const filePath = path.join(this.cacheDir, `${cacheKey}.json`)
      const stats = await fs.stat(filePath)
      const fileData = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      const maxAge = fileData.maxAge || options.maxAge

      if (!this.isExpired({ timestamp: stats.mtimeMs }, maxAge)) {
        this.setMemoryCache(cacheKey, fileData.data, maxAge)
        return fileData.data
      }

      // 删除过期文件
      await fs.unlink(filePath).catch(() => {})
    } catch (error) {
      // 文件不存在或其他错误，忽略
      if (error.code !== 'ENOENT') {
        console.warn(`读取缓存文件失败: ${error.message}`)
      }
    }

    return null
  }

  async set(key, data, options = {}) {
    if (!this.initialized) {
      await this.init()
    }

    const cacheKey = this.generateKey(key)

    // 设置内存缓存
    this.setMemoryCache(cacheKey, data, options.maxAge)

    // 设置文件缓存
    try {
      const filePath = path.join(this.cacheDir, `${cacheKey}.json`)
      const cacheData = {
        data,
        maxAge: options.maxAge,
        timestamp: Date.now(),
      }

      // 使用临时文件写入，然后重命名，避免写入中断导致的文件损坏
      const tempPath = `${filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(cacheData), 'utf-8')
      await fs.rename(tempPath, filePath)
    } catch (error) {
      console.error('写入缓存文件失败:', error)
    }
  }

  setMemoryCache(key, data, maxAge) {
    // 如果内存缓存项过多，删除最早访问的项
    if (
      this.memoryCache.size >= this.maxMemoryItems &&
      !this.memoryCache.has(key)
    ) {
      if (this.accessOrder.length > 0) {
        const oldestKey = this.accessOrder.shift()
        this.memoryCache.delete(oldestKey)
      }
    }

    this.memoryCache.set(key, {
      data,
      timestamp: Date.now(),
      maxAge,
    })

    // 更新访问顺序
    this.updateAccessOrder(key)
  }

  updateAccessOrder(key) {
    // 从当前位置移除
    this.removeFromAccessOrder(key)
    // 添加到末尾（最近访问）
    this.accessOrder.push(key)
  }

  removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key)
    if (index !== -1) {
      this.accessOrder.splice(index, 1)
    }
  }

  isExpired(item, maxAge) {
    if (!maxAge) maxAge = this.maxFileAge
    return Date.now() - item.timestamp > maxAge
  }

  async cleanup() {
    if (!this.initialized) {
      return
    }

    try {
      const files = await fs.readdir(this.cacheDir)
      const now = Date.now()

      await Promise.all(
        files.map(async (file) => {
          if (!file.endsWith('.json')) return

          try {
            const filePath = path.join(this.cacheDir, file)
            const stats = await fs.stat(filePath)

            // 检查文件是否过期
            if (now - stats.mtimeMs > this.maxFileAge) {
              await fs.unlink(filePath).catch(() => {})
            } else {
              // 尝试读取文件内容检查内部过期时间
              try {
                const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
                if (
                  content.maxAge &&
                  now - content.timestamp > content.maxAge
                ) {
                  await fs.unlink(filePath).catch(() => {})
                }
              } catch (e) {
                // 如果文件格式错误，删除它
                await fs.unlink(filePath).catch(() => {})
              }
            }
          } catch (err) {
            // 忽略单个文件的错误，继续处理其他文件
            console.warn(`处理缓存文件 ${file} 时出错: ${err.message}`)
          }
        })
      )
    } catch (error) {
      console.error('清理过期缓存文件失败:', error)
    }
  }
}

export const cache = new Cache()
