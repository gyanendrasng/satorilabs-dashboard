import { NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';

export async function GET() {
  try {
    const credential = new ClientSecretCredential(
      process.env.AZURE_TENANT_ID!,
      process.env.AZURE_CLIENT_ID!,
      process.env.AZURE_CLIENT_SECRET!
    );

    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
    const client = new ComputeManagementClient(credential, subscriptionId);

    const vms: any[] = [];

    for await (const vm of client.virtualMachines.listAll()) {
      // 🔹 extract the resource group name from the full VM ID
      const rgName = vm.id?.split('/')[4]!;
      let powerState = 'Unknown';

      try {
        // ✅ fetch the instance view for this VM (contains PowerState)
        const view = await client.virtualMachines.instanceView(
          rgName,
          vm.name!
        );
        powerState =
          view.statuses?.find((s) => s.code?.startsWith('PowerState/'))
            ?.displayStatus ?? 'Unknown';
      } catch (e) {
        console.warn(
          `Could not fetch state for ${vm.name}:`,
          (e as Error).message
        );
      }

      vms.push({
        name: vm.name,
        location: vm.location,
        id: vm.id,
        size: vm.hardwareProfile?.vmSize,
        powerState,
      });
    }

    console.log('VMs:', vms);
    return NextResponse.json({ vms });
  } catch (err: any) {
    console.error('Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
