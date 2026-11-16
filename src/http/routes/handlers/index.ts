/** 汇总所有 handler 到注册表（manifest.handler → 实现）。 */
import type { HandlerRegistry } from '../helpers.js';
import { goalHandlers, runHandlers, changeHandlers } from './core.js';
import { companyHandlers, platformHandlers, customsHandlers } from './companies.js';
import { webhookHandlers, jobHandlers, runtimeHandlers } from './ops.js';
import { adminHandlers } from '../admin.js';

export const ROUTE_HANDLERS: HandlerRegistry = {
  ...goalHandlers,
  ...runHandlers,
  ...changeHandlers,
  ...companyHandlers,
  ...platformHandlers,
  ...customsHandlers,
  ...webhookHandlers,
  ...jobHandlers,
  ...runtimeHandlers,
  ...adminHandlers,
};
