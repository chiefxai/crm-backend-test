// Provider-agnostic job queue facade.
// Business logic only uses enqueue/process/start/stop/getStats. Providers are
// selected by QUEUE_PROVIDER, so RabbitMQ can be replaced later without
// changing callers.
const { createMemoryQueueAdapter } = require("./adapters/memoryQueueAdapter");
const { createRabbitMqQueueAdapter } = require("./adapters/rabbitMqQueueAdapter");
const { createOciQueueAdapter } = require("./adapters/ociQueueAdapter");
const { createAwsSqsQueueAdapter } = require("./adapters/awsSqsQueueAdapter");

const { wrapWorkspaceQueue } = require("./workspaceQueue");
let instance = null;

function getQueue() {
  if (instance) return instance;
  const provider = (process.env.QUEUE_PROVIDER || "memory").toLowerCase();
  switch (provider) {
    case "memory":
      instance = createMemoryQueueAdapter();
      break;
    case "rabbitmq":
    case "rabbit":
      instance = createRabbitMqQueueAdapter();
      break;
    case "oci":
    case "oci_queue":
      instance = createOciQueueAdapter();
      break;
    case "aws_sqs":
    case "sqs":
      instance = createAwsSqsQueueAdapter();
      break;
    default:
      throw new Error(`[queue] unknown QUEUE_PROVIDER "${provider}" — supported: memory, rabbitmq, oci_queue, aws_sqs`);
  }
  instance = wrapWorkspaceQueue(instance);
  // start() is intentionally not awaited to preserve the existing synchronous
  // getQueue() API. RabbitMQ buffers enqueues until its channel is ready.
  Promise.resolve(instance.start()).catch(err => {
    console.error(`[queue] failed to start ${provider} provider:`, err);
  });
  return instance;
}

function getQueueHealth() {
  const queue = getQueue();
  return { ready: typeof queue.isReady === "function" ? queue.isReady() : true, stats: queue.getStats() };
}

module.exports = { getQueue, getQueueHealth };
