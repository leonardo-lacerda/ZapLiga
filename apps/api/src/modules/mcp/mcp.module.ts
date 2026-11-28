import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { LineMonitorModule } from '../line-monitor/line-monitor.module';
import { NumbersModule } from '../numbers/numbers.module';
import { WhatsappProvisioningModule } from '../whatsapp-provisioning/whatsapp-provisioning.module';
import { McpKeysService } from './mcp-keys.service';
import { McpController, McpKeysController } from './mcp.controller';
import { McpKeyGuard } from './mcp.guard';
import { McpToolsFactory } from './mcp.tools';

/** Claude operating phones, registrations and lines through MCP (docs/mcp.md). */
@Module({
  imports: [AuditModule, FeatureFlagsModule, LineMonitorModule, NumbersModule, WhatsappProvisioningModule],
  controllers: [McpController, McpKeysController],
  providers: [McpKeysService, McpKeyGuard, McpToolsFactory],
})
export class McpModule {}
