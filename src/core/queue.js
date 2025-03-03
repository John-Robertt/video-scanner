import EventEmitter from 'events'

class TaskQueue extends EventEmitter {
  constructor(concurrency = 32) {
    super()
    this.concurrency = concurrency
    this.running = 0
    this.queue = []
    this.results = []
    this.errors = []
    this.isStopped = false
    this.maxStoredResults = 1000
    this.completedCount = 0
  }

  async add(task, priority = 0, timeout = 0) {
    return new Promise((resolve, reject) => {
      if (this.isStopped) {
        reject(new Error('任务队列已停止接受新任务'))
        return
      }

      const queueItem = {
        task,
        priority,
        resolve,
        reject,
        cancelled: false,
        timestamp: Date.now(),
      }

      if (timeout > 0) {
        queueItem.timeoutId = setTimeout(() => {
          if (!queueItem.started) {
            queueItem.cancelled = true
            reject(new Error('任务等待超时'))
          }
        }, timeout)
      }

      this.queue.push(queueItem)
      this.queue.sort(
        (a, b) => b.priority - a.priority || a.timestamp - b.timestamp
      )
      this.process()
    })
  }

  async process() {
    if (
      this.running >= this.concurrency ||
      this.queue.length === 0 ||
      this.isStopped
    ) {
      return
    }

    const item = this.queue.shift()

    if (item.cancelled) {
      setImmediate(() => this.process())
      return
    }

    this.running++
    this.emit('taskStart', {
      queueLength: this.queue.length,
      running: this.running,
    })

    item.started = true
    if (item.timeoutId) {
      clearTimeout(item.timeoutId)
    }

    try {
      const result = await item.task()
      this.results.push(result)
      this.completedCount++
      item.resolve(result)
      this.emit('taskComplete', result)
    } catch (error) {
      this.errors.push(error)
      item.reject(error)
      this.emit('taskError', error)
    } finally {
      this.running--
      setImmediate(() => this.process())
    }

    if (this.results.length > this.maxStoredResults) {
      this.results = this.results.slice(-this.maxStoredResults)
    }
    if (this.errors.length > this.maxStoredResults) {
      this.errors = this.errors.slice(-this.maxStoredResults)
    }
  }

  async processAll(tasks, priority = 0) {
    const promises = tasks.map((task) => this.add(task, priority))
    return Promise.all(promises)
  }

  cancel(predicate) {
    let cancelCount = 0
    this.queue.forEach((item) => {
      if (predicate(item.task)) {
        item.cancelled = true
        item.reject(new Error('任务已取消'))
        cancelCount++
      }
    })

    this.queue = this.queue.filter((item) => !item.cancelled)

    return cancelCount
  }

  stop() {
    this.isStopped = true
    this.queue.forEach((item) => {
      item.reject(new Error('任务队列已停止'))
    })
    this.queue = []
    this.emit('stopped')
  }

  resume() {
    this.isStopped = false
    this.emit('resumed')
  }

  getStats() {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.completedCount,
      errors: this.errors.length,
      isStopped: this.isStopped,
    }
  }

  clear() {
    this.queue = []
    this.results = []
    this.errors = []
  }

  setConcurrency(newConcurrency) {
    this.concurrency = newConcurrency
    setImmediate(() => this.process())
  }
}

export const taskQueue = new TaskQueue()
