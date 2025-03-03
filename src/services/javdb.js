// 处理与 javdb 的交互
import axios from 'axios'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'
import { logger } from './logger.js'
import { createRetryableFunction } from '../utils/retry.js'

export class JavdbService {
  constructor() {
    this.baseUrl = null
    this.cookies = ''
    this.client = null
    this.proxy = null

    // 使用新的重试机制创建可重试的方法
    this.searchVideo = createRetryableFunction(this._searchVideo.bind(this), {
      maxRetries: 3,
      baseDelay: 2000,
      maxDelay: 10000,
      stepId: 'javdb-search',
    })

    this.getVideoDetail = createRetryableFunction(
      this._getVideoDetail.bind(this),
      {
        maxRetries: 3,
        baseDelay: 2000,
        maxDelay: 10000,
        stepId: 'javdb-detail',
      }
    )
  }

  /**
   * 读取代理配置文件
   * @returns {Object|null} 代理配置对象
   */
  readProxyConfig() {
    const proxyConfigPath = path.join(process.cwd(), 'config', 'proxy.json')

    try {
      logger.startStep('proxy', 'read', '正在读取代理配置文件')

      if (!fs.existsSync(proxyConfigPath)) {
        logger.completeStep('proxy', 'read', '代理配置文件不存在，将不使用代理')
        return null
      }

      const proxyConfig = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf-8'))
      logger.completeStep('proxy', 'read', '成功读取代理配置')
      return proxyConfig
    } catch (error) {
      logger.failStep('proxy', 'read', `读取代理配置失败: ${error.message}`)
      return null
    }
  }

  /**
   * 初始化服务
   * @param {Object} config 配置对象
   */
  initialize(config) {
    this.baseUrl = config.get('scraper.javdb.baseUrl')
    const cookieFile = config.get('scraper.javdb.cookieFile')
    this.cookies = this.parseCookieFile(cookieFile)
    this.proxy = this.readProxyConfig()

    const axiosConfig = {
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        Cookie: this.cookies,
      },
      validateStatus: (status) => status >= 200 && status < 300,
    }

    // 如果存在代理配置，添加到axios配置中
    if (this.proxy) {
      axiosConfig.proxy = this.proxy
    }

    this.client = axios.create(axiosConfig)
  }

  /**
   * 解析cookie文件
   * @param {string} filePath cookie文件路径
   * @returns {string} cookie字符串
   */
  parseCookieFile(filePath) {
    if (!filePath) {
      logger.startStep('cookie', 'parse', 'Cookie文件解析')
      logger.completeStep(
        'cookie',
        'parse',
        '未指定Cookie文件路径，将使用空cookie继续'
      )
      return ''
    }

    try {
      logger.startStep('cookie', 'parse', `开始解析Cookie文件: ${filePath}`)

      if (!fs.existsSync(filePath)) {
        logger.completeStep(
          'cookie',
          'parse',
          `Cookie文件 ${filePath} 不存在，将使用空cookie继续`
        )
        return ''
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n')

      // 过滤注释行和空行,解析cookie
      const cookieItems = lines
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          // Netscape cookie 文件格式：
          // domain  domain_initial_dot  path  secure  expiration  name  value
          const fields = line.split('\t')
          if (fields.length < 7) return null

          const [domain, , , , , name, value] = fields

          // 验证必要字段
          if (!domain?.includes('javdb.com') || !name || !value) {
            return null
          }

          return `${name.trim()}=${value.trim()}`
        })
        .filter(Boolean)

      // 使用Map去重,保留最新的cookie
      const cookieMap = new Map()
      cookieItems.forEach((item) => {
        const [name] = item.split('=')
        cookieMap.set(name, item)
      })

      const cookieString = Array.from(cookieMap.values()).join('; ')
      logger.completeStep(
        'cookie',
        'parse',
        `成功解析Cookie文件，获取到 ${cookieMap.size} 个有效Cookie`
      )
      return cookieString
    } catch (error) {
      logger.failStep('cookie', 'parse', `解析Cookie文件失败: ${error.message}`)
      return ''
    }
  }

  /**
   * 搜索视频
   * @param {string} code 视频编号
   * @returns {Promise<string>} 详情页URL
   * @private
   */
  async _searchVideo(code) {
    if (!code?.trim()) {
      throw new Error('视频编号不能为空')
    }

    logger.startStep(code, 'javdb-search', `正在搜索视频: ${code}`)

    // 搜索页面，添加中文区域参数
    const searchUrl = `/search?q=${encodeURIComponent(code.trim())}&f=all&locale=zh`
    const searchResponse = await this.client.get(searchUrl)
    const $ = cheerio.load(searchResponse.data)

    // 遍历搜索结果列表查找匹配的番号
    let detailUrl = null
    $('.movie-list .item').each((_, item) => {
      const $item = $(item)
      const videoTitle = $item.find('.video-title').text()
      const videoCode = videoTitle.match(/^([a-zA-Z0-9-]+)/)?.[1]

      if (
        videoCode &&
        videoCode.replace(/\s+/g, '').toLowerCase() ===
          code.trim().toLowerCase()
      ) {
        detailUrl = this.baseUrl + $item.find('a').attr('href')
        return false
      }
    })

    if (!detailUrl) {
      logger.failStep(code, 'javdb-search', '未找到匹配的视频信息')
      throw new Error('未找到匹配的视频信息')
    }

    logger.completeStep(code, 'javdb-search', `找到匹配视频: ${detailUrl}`)

    return detailUrl
  }

  /**
   * 获取视频详情
   * @param {string} code 视频编号
   * @param {string} detailUrl 详情页URL
   * @returns {Promise<Object>} 视频详情
   * @private
   */
  async _getVideoDetail(code, detailUrl) {
    logger.startStep(code, 'javdb-detail', '正在获取视频详细信息')

    const detailResponse = await this.client.get(detailUrl)
    const detail$ = cheerio.load(detailResponse.data)

    // 获取番号和标题
    const detialCode = detail$(
      '.movie-panel-info .panel-block:contains("番號") .value'
    )
      .text()
      .trim()
    let title
    const originTitle = detail$('.video-detail .title .origin-title')
      .text()
      .trim()
    if (originTitle) {
      // 如果存在原始标题，使用原始标题
      title = detialCode + ' ' + originTitle
    } else {
      // 如果不存在原始标题，使用当前显示的标题
      title =
        detialCode +
        ' ' +
        detail$('.video-detail .title .current-title').text().trim()
    }

    const rating = detail$(
      '.movie-panel-info .panel-block:contains("評分") .value'
    )
      .text()
      .trim()

    // 解析评分数据
    let ratingValue = ''
    let ratingVotes = ''
    if (rating) {
      // 从格式如 "3.43分, 由35人評價" 中提取评分和投票数
      const ratingMatch = rating.match(/(\d+\.\d+)分.*?(\d+)人/)
      if (ratingMatch) {
        // 将5分制评分转换为10分制
        ratingValue = (parseFloat(ratingMatch[1]) * 2).toFixed(2)
        ratingVotes = ratingMatch[2]
      }
    }

    const videoInfo = {
      title: title,
      code: detialCode,
      releaseDate: detail$(
        '.movie-panel-info .panel-block:contains("日期") .value'
      )
        .text()
        .trim(),
      duration: detail$(
        '.movie-panel-info .panel-block:contains("時長") .value'
      )
        .text()
        .trim(),
      maker: detail$('.movie-panel-info .panel-block:contains("片商") .value')
        .text()
        .trim(),
      series: detail$('.movie-panel-info .panel-block:contains("系列") .value')
        .text()
        .trim(),
      ratingValue,
      ratingVotes,
      categories: detail$(
        '.movie-panel-info .panel-block:contains("類別") .value a'
      )
        .map((_, el) => detail$(el).text().trim())
        .get(),
      actors: detail$(
        '.movie-panel-info .panel-block:contains("演員") .value a'
      )
        .map((_, el) => detail$(el).text().trim())
        .get(),
      coverUrl: detail$('.column-video-cover img').attr('src'),
      detailUrl: detailUrl,
    }

    logger.completeStep(code, 'javdb-detail', `成功获取视频 ${code} 的详细信息`)

    return videoInfo
  }

  /**
   * 获取视频信息
   * @param {string} code 视频编号
   * @param {Object} config 配置对象
   * @returns {Promise<Object>} 视频元数据
   */
  async getVideoInfo(code, config) {
    if (!code?.trim()) {
      throw new Error('视频编号不能为空')
    }

    if (!this.client) {
      this.initialize(config)
    }

    logger.startStep(code, 'javdb', `开始从JavDB获取视频 ${code} 的信息`)

    try {
      // 搜索视频获取详情页URL
      const detailUrl = await this.searchVideo(code)

      // 获取视频详细信息
      const videoInfo = await this.getVideoDetail(code, detailUrl)

      logger.completeStep(code, 'javdb', `完成获取视频 ${code} 的信息`)
      return videoInfo
    } catch (error) {
      logger.failStep(code, 'javdb', `获取视频信息失败: ${error.message}`)
      throw error
    }
  }
}

export const javdb = new JavdbService()
