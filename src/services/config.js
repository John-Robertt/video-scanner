import YAML from 'yaml'
import fs from 'fs/promises'
import path from 'path'

export class Config {
  constructor() {
    this.config = null
    this.defaultConfig = {
      base: {
        sourceDir: '.',
        outputDir: '',
        skipHiddenFiles: true,
        excludeDirs: [
          'node_modules',
          'temp',
          'downloads',
          '@eaDir',
          'output',
          '.log',
          '.cache',
        ],
      },
      cache: {
        dir: '.cache',
        maxMemoryItems: 1000,
        maxAge: 86400000,
      },
      fileTypes: {
        video: [
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
        ],
      },
      scraper: {
        default: 'javdb',
        javdb: {
          baseUrl: 'https://javdb.com',
          cookieFile: 'config/cookie.txt',
          timeout: 10000,
          retry: 3,
          retryDelay: 1000,
        },
      },
      log: {
        enabled: true,
        path: 'log',
        filename: 'app.log',
      },
    }
  }

  /**
   * 深度合并对象
   * @param {Object} target 目标对象
   * @param {Object} source 源对象
   * @returns {Object} 合并后的对象
   */
  deepMerge(target, source) {
    const result = { ...target }
    for (const key in source) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key])
      } else {
        result[key] = source[key]
      }
    }
    return result
  }

  /**
   * 加载配置文件
   * @param {string} [configPath='config/config.yml'] 配置文件路径
   */
  async load(configPath = 'config/config.yml') {
    try {
      const configFile = await fs.readFile(configPath, 'utf8')
      const userConfig = YAML.parse(configFile)

      // 将用户配置与默认配置合并
      this.config = this.deepMerge(this.defaultConfig, userConfig)

      // 处理路径配置
      this.config.base.sourceDir = path.resolve(
        process.cwd(),
        this.config.base.sourceDir || '.'
      )

      // 修改输出目录的处理方式
      const outputDir = this.config.base.outputDir || 'output'
      this.config.base.outputDir = path.resolve(
        this.config.base.sourceDir,
        outputDir
      )

      // 确保日志配置的一致性
      if (!this.config.log.path) {
        this.config.log.path = '.log'
      }

      // 如果日志路径不是绝对路径，则相对于源目录的父目录
      if (!path.isAbsolute(this.config.log.path)) {
        // 不修改原始配置中的相对路径，只在使用时进行解析
      }

      return this.config
    } catch (error) {
      console.error('加载配置文件失败:', error)
      throw error
    }
  }

  /**
   * 获取配置项
   * @param {string} key 配置键名，使用点号分隔，如 'base.sourceDir'
   * @param {any} defaultValue 默认值
   */
  get(key, defaultValue = null) {
    if (!this.config) {
      throw new Error('配置未加载，请先调用 load() 方法')
    }

    const keys = key.split('.')
    let value = this.config

    for (const k of keys) {
      if (value === undefined || value === null) {
        return defaultValue
      }
      value = value[k]
    }

    return value === undefined ? defaultValue : value
  }
}

export const config = new Config()
