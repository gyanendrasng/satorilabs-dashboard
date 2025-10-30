'use client';

import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

interface VM {
  name: string;
  location: string;
  id: string;
  size: string;
  powerState: string;
}

export default function Dashboard() {
  const [vms, setVms] = useState<VM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/backend/vms')
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setVms(data.vms);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="container mx-auto py-10">Loading VMs...</div>;
  }

  if (error) {
    return (
      <div className="container mx-auto py-10 text-red-600">Error: {error}</div>
    );
  }

  return (
    <div className="container mx-auto py-10">
      <h1 className="text-3xl font-bold mb-6">Virtual Machines</h1>
      <Table>
        <TableCaption>A list of all Azure virtual machines.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Power State</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vms.map((vm) => (
            <TableRow key={vm.id}>
              <TableCell className="font-medium">{vm.name}</TableCell>
              <TableCell>{vm.location}</TableCell>
              <TableCell>{vm.size?.replace(/_/g, ' ')}</TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    vm.powerState.includes('running')
                      ? 'bg-green-100 text-green-800'
                      : vm.powerState.includes('stopped')
                      ? 'bg-gray-100 text-gray-800'
                      : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {vm.powerState}
                </span>
              </TableCell>
              <TableCell
                className="font-mono text-xs text-gray-500 max-w-md truncate"
                title={vm.id}
              >
                {vm.id}
              </TableCell>
              <TableCell>
                <Button
                  className="cursor-pointer"
                  onClick={() => (window.location.href = '/guac')}
                >
                  Connect
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
