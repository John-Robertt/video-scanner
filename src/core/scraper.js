// 根据配置选择不同的刮削网站
import { JavdbService } from '../services/javdb.js'

export class Scraper {
  constructor() {
    this.javdb = new JavdbService()
  }

  /**
   * 获取视频信息
   * @param {string} code 视频编号
   * @param {Object} config 配置对象
   * @returns {Promise<Object>} 视频元数据
   */
  async getVideoInfo(code, config) {
    // 初始化 javdb 服务
    this.javdb.initialize(config)

    // 获取视频信息
    return await this.javdb.getVideoInfo(code, config)
  }
}

export const scraper = new Scraper()
