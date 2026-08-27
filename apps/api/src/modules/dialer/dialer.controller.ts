import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { DialerService } from './dialer.service';

@Controller()
export class DialerController {
  constructor(private readonly dialer: DialerService) {}

  @Get('/api/dialer/status') status() { return this.dialer.getStatus(); }
  @Get('/api/dialer/logs') logs() { return this.dialer.getLogs(); }
  @Post('/api/dialer/start') start() { return this.dialer.start(); }
  @Post('/api/dialer/pause') pause() { return this.dialer.pause(); }
  @Patch('/api/dialer/settings') settings(@Body() body: any) { return this.dialer.updateSettings(body); }
}
