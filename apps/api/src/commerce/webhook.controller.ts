import {
  Controller,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Post,
  Req,
} from '@nestjs/common';
import { errorCodes } from '@knowledge-explorer/shared';
import { PurchaseService } from './purchase.service';

/**
 * §9.4's `POST /webhooks/payment` — FR-COM-03.
 *
 * NO `@UseGuards`, NO `@RequirePermission`, DELIBERATELY. The caller is a payment
 * gateway: it has no session and must not need one. Its only credential is the
 * signature `PaymentProvider.verifyWebhook` checks over the RAW request bytes.
 * An endpoint with no declared permission looks exactly like the omission
 * deny-by-default exists to catch, so the absence is asserted by name in
 * test/commerce-webhook.e2e-spec.ts — "serves an unsigned caller with 401, not
 * 403" — as it is for PublicCatalogController.
 *
 * `rawBody` requires `NestFactory.create(AppModule, { rawBody: true })` (main.ts)
 * and the same option on every test app that posts webhooks.
 */

/** The request fields this controller reads, kept free of express types. */
interface RawWebhookRequest {
  readonly rawBody?: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
}

@Controller('webhooks')
export class PaymentWebhookController {
  constructor(@Inject(PurchaseService) private readonly purchases: PurchaseService) {}

  @Post('payment')
  @HttpCode(200)
  async payment(@Req() request: RawWebhookRequest): Promise<{ received: true }> {
    /**
     * A missing raw body is a wiring fault, never a reason to verify
     * `JSON.stringify(request.body)` instead: re-serialized JSON passes every
     * self-signed test and fails against a gateway whose whitespace or key order
     * differs from Node's.
     */
    if (!request.rawBody) {
      throw new InternalServerErrorException({ errorCode: errorCodes.WEBHOOK_RAW_BODY_MISSING });
    }

    await this.purchases.handleWebhook({ rawBody: request.rawBody, headers: request.headers });
    return { received: true };
  }
}
