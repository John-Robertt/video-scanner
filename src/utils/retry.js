import { logger } from '../services/logger.js'

// 全局中断状态和处理器
let isAborting = false
const cleanupFunctions = []

// 全局中断处理器
const globalAbortHandler = () => {
  isAborting = true
  // 执行所有清理函数
  while (cleanupFunctions.length > 0) {
    const cleanup = cleanupFunctions.pop()
    try {
      cleanup()
    } catch (error) {
      console.error('清理函数执行失败:', error)
    }
  }
  process.exit(1) // 强制退出进程
}

// 只添加一次全局事件监听器
process.on('SIGINT', globalAbortHandler)
process.on('SIGTERM', globalAbortHandler)

/**
 * 通用重试函数
 * @param {Function} operation 要重试的操作函数
 * @param {Object} options 重试配置选项
 * @param {number} options.maxRetries 最大重试次数
 * @param {number} options.baseDelay 基础延迟时间(ms)
 * @param {number} options.maxDelay 最大延迟时间(ms)
 * @param {string} options.taskId 任务标识
 * @param {string} options.stepId 步骤标识
 * @returns {Promise<any>} 操作结果
 */
export async function retryOperation(
  operation,
  {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    taskId = 'system',
    stepId = 'retry',
  } = {}
) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation 必须是一个函数')
  }

  if (maxRetries < 1) {
    throw new Error('maxRetries 必须大于 0')
  }

  if (baseDelay < 0 || maxDelay < 0) {
    throw new Error('延迟时间不能为负数')
  }

  let lastError
  const localCleanupFunctions = []

  try {
    logger.startStep(
      taskId,
      stepId,
      `开始执行操作，最大重试次数: ${maxRetries}`
    )

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (isAborting) {
        logger.failStep(taskId, stepId, '操作被用户中断')
        throw new Error('操作被用户中断')
      }

      try {
        const result = await operation()
        logger.completeStep(taskId, stepId, `操作成功完成`)
        return result
      } catch (error) {
        lastError = error

        if (attempt < maxRetries - 1 && !isAborting) {
          const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)

          logger.startStep(
            taskId,
            stepId,
            `操作失败，将在 ${delay / 1000} 秒后进行第 ${attempt + 1} 次重试: ${error.message}`
          )

          // 使用可中断的延迟
          await new Promise((resolve, reject) => {
            if (isAborting) {
              reject(new Error('操作被用户中断'))
              return
            }

            const timer = setTimeout(resolve, delay)
            const cleanupTimer = () => clearTimeout(timer)

            // 添加到本地和全局清理函数列表
            localCleanupFunctions.push(cleanupTimer)
            cleanupFunctions.push(cleanupTimer)
          })
        }
      }
    }

    const enhancedError = new Error(
      `操作在重试 ${maxRetries} 次后仍然失败: ${lastError.message}`
    )
    enhancedError.originalError = lastError
    enhancedError.attempts = maxRetries
    enhancedError.stack = lastError.stack

    logger.failStep(taskId, stepId, enhancedError.message)
    throw enhancedError
  } finally {
    // 从全局清理函数列表中移除本地清理函数
    for (const cleanup of localCleanupFunctions) {
      const index = cleanupFunctions.indexOf(cleanup)
      if (index !== -1) {
        cleanupFunctions.splice(index, 1)
      }
    }

    // 执行本地清理函数
    for (const cleanup of localCleanupFunctions) {
      try {
        cleanup()
      } catch (error) {
        console.error('清理函数执行失败:', error)
      }
    }
  }
}

/**
 * 创建一个可重试的函数
 * @param {Function} fn 原始函数
 * @param {Object} options 重试配置选项
 * @param {number} options.maxRetries 最大重试次数
 * @param {number} options.baseDelay 基础延迟时间(ms)
 * @param {number} options.maxDelay 最大延迟时间(ms)
 * @returns {Function} 包装后的可重试函数
 */
export function createRetryableFunction(fn, defaultOptions = {}) {
  return async function (...args) {
    const taskId = args[0] || 'system' // 假设第一个参数是任务ID
    const stepId = defaultOptions.stepId || fn.name || 'retry'

    const options = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      ...defaultOptions,
      taskId,
      stepId,
    }

    return retryOperation(() => fn.apply(this, args), options)
  }
}
