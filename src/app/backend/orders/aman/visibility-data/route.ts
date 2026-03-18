import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendPlainEmail } from '@/lib/gmail';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

interface VisibilityMaterial {
  material_code: string;
  batch_number: string;
  order_quantity: number;
}

interface VisibilityPayload {
  so_number?: string;
  soNumber?: string;
  email_body: string;
  materials: VisibilityMaterial[];
}

/**
 * POST /backend/orders/aman/visibility-data
 *
 * Receives ZSO-VISIBILITY response from Aman (auto_gui2) as application/json.
 * JSON body must contain `email_body` (string), `materials` (array),
 * and optionally `so_number` or `soNumber`. Falls back to CurrentSO singleton.
 *
 * 1. Reads SO number from payload or CurrentSO singleton
 * 2. Sends email_body to BRANCH_EMAIL
 * 3. Stores materials (with batch + quantity) on the Email record for later use in ZLOAD1
 * 4. Creates Email record with emailType='ls_dispatch' for tracking branch reply
 */
export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    console.log(`[VisibilityData] Raw body (${rawText.length} chars):`, rawText.slice(0, 500));

    let body: VisibilityPayload;
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error(`[VisibilityData] JSON parse failed. Full body:`, rawText);
      return NextResponse.json(
        { error: 'Invalid JSON in request body', receivedPreview: rawText.slice(0, 200) },
        { status: 400 }
      );
    }

    console.log(`[VisibilityData] Parsed payload keys:`, Object.keys(body));
    console.log(`[VisibilityData] so_number=${body.so_number}, soNumber=${body.soNumber}, materials=${body.materials?.length}, email_body length=${body.email_body?.length}`);
    console.log(`[VisibilityData] Full body contents:`, rawText);

    const { email_body, materials } = body;

    if (!email_body) {
      return NextResponse.json(
        { error: 'email_body is required' },
        { status: 400 }
      );
    }

    if (!materials || !Array.isArray(materials) || materials.length === 0) {
      return NextResponse.json(
        { error: 'materials array is required and must not be empty' },
        { status: 400 }
      );
    }

    // SO lookup priority: so_number → soNumber → CurrentSO singleton
    let soNumber = body.so_number || body.soNumber;
    console.log(`[VisibilityData] Step 1: SO number from body="${soNumber}"`);
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'No current SO number set and soNumber not provided' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
      console.log(`[VisibilityData] Step 1: Fell back to CurrentSO="${soNumber}"`);
    }

    // Find the sales order
    console.log(`[VisibilityData] Step 2: Looking up SO ${soNumber} in DB...`);
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { items: true },
    });

    if (!salesOrder) {
      console.error(`[VisibilityData] Step 2 FAILED: SO ${soNumber} not found in DB`);
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }
    console.log(`[VisibilityData] Step 2: Found SO ${soNumber} (id=${salesOrder.id}, items=${salesOrder.items.length})`);

    if (!BRANCH_EMAIL) {
      return NextResponse.json(
        { error: 'BRANCH_EMAIL environment variable not configured' },
        { status: 500 }
      );
    }

    // Create a LoadingSlipItem to attach the Email record to
    // (use first material as identifier, or create a placeholder)
    let loadingSlipItem = salesOrder.items[0];
    if (!loadingSlipItem) {
      console.log(`[VisibilityData] Step 2b: No items on SO, creating LoadingSlipItem...`);
      try {
        loadingSlipItem = await prisma.loadingSlipItem.create({
          data: {
            salesOrderId: salesOrder.id,
            lsNumber: `DISPATCH-${soNumber}`,
            material: materials[0]?.material_code || 'PENDING',
            status: 'pending',
          },
        });
        console.log(`[VisibilityData] Step 2b: Created LoadingSlipItem id=${loadingSlipItem.id}`);
      } catch (lsiErr) {
        console.error(`[VisibilityData] Step 2b FAILED: LoadingSlipItem create threw:`, lsiErr);
        return NextResponse.json(
          { error: 'Failed to create LoadingSlipItem', details: lsiErr instanceof Error ? lsiErr.message : String(lsiErr) },
          { status: 500 }
        );
      }
    }

    // Send dispatch status email to branch
    console.log(`[VisibilityData] Step 3: Sending email to ${BRANCH_EMAIL}...`);
    const subject = `Dispatch Status - Sales Order ${soNumber}`;
    let messageId: string;
    let threadId: string;
    try {
      const result = await sendPlainEmail(
        BRANCH_EMAIL,
        subject,
        email_body
      );
      messageId = result.messageId;
      threadId = result.threadId;
    } catch (emailErr) {
      console.error(`[VisibilityData] Step 3 FAILED: sendPlainEmail threw:`, emailErr);
      return NextResponse.json(
        { error: 'Failed to send dispatch email', details: emailErr instanceof Error ? emailErr.message : String(emailErr) },
        { status: 500 }
      );
    }

    console.log(
      `[VisibilityData] Step 3: Sent dispatch email to ${BRANCH_EMAIL} for SO ${soNumber} - messageId: ${messageId}`
    );

    // Store full materials array (with batch + quantity) for ZLOAD1 later
    const materialsJson = JSON.stringify(materials);

    // Create Email record for tracking branch reply
    console.log(`[VisibilityData] Step 4: Creating Email record...`);
    await prisma.email.create({
      data: {
        loadingSlipItemId: loadingSlipItem.id,
        gmailMessageId: messageId,
        gmailThreadId: threadId,
        recipientEmail: BRANCH_EMAIL,
        subject,
        status: 'sent',
        emailType: 'ls_dispatch',
        workflowState: 'awaiting_reply',
        relatedMaterials: materialsJson,
      },
    });

    console.log(
      `[VisibilityData] Created email record for SO ${soNumber} with ${materials.length} materials`
    );

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      soNumber,
      emailSent: true,
      messageId,
      materialsCount: materials.length,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    console.error(`[VisibilityData] UNHANDLED ERROR: ${errMsg}`);
    console.error(`[VisibilityData] Stack:`, errStack || error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: errMsg,
      },
      { status: 500 }
    );
  }
}
