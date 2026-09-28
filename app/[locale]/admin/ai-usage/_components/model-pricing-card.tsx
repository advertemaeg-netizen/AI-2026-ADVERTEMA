'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { deleteModelPrice, saveModelPrice } from '@/lib/actions/ai-usage'
import type { ModelPrice } from '@/lib/types/ai-usage'
import { ltr } from './ltr'

/**
 * USD per million tokens for each model. A call is priced when it's logged,
 * so a change only affects new calls (and calls logged before the model had
 * a price).
 */
export function ModelPricingCard({ models }: { models: ModelPrice[] }) {
  const t = useTranslations('aiUsage.models')
  const format = useFormatter()
  const [editing, setEditing] = useState<ModelPrice | 'new' | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [isDeleting, startDeleting] = useTransition()
  const usd = (value: number) =>
    ltr(format.number(value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }))

  function confirmDelete() {
    if (!deleting) return
    startDeleting(async () => {
      const result = await deleteModelPrice(deleting)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        setDeleting(null)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus data-icon="inline-start" />
          {t('add')}
        </Button>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.model')}</TableHead>
                <TableHead className="text-end">{t('columns.input')}</TableHead>
                <TableHead className="text-end">{t('columns.output')}</TableHead>
                <TableHead>{t('columns.updated')}</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">{t('columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.model}>
                  <TableCell className="font-mono text-sm" dir="ltr">
                    <span className="block text-start">{model.model}</span>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{usd(model.input_price_per_million)}</TableCell>
                  <TableCell className="text-end tabular-nums">{usd(model.output_price_per_million)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(new Date(model.updated_at), { dateStyle: 'medium' })}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditing(model)} aria-label={t('edit', { model: model.model })}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(model.model)} aria-label={t('delete', { model: model.model })}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {editing && (
        <ModelPriceDialog model={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && !isDeleting && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle', { model: deleting ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
            >
              {t('confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function ModelPriceDialog({ model, onClose }: { model: ModelPrice | null; onClose: () => void }) {
  const t = useTranslations('aiUsage.models')
  const tCommon = useTranslations('common')
  const [name, setName] = useState(model?.model ?? '')
  const [input, setInput] = useState(model ? String(model.input_price_per_million) : '')
  const [output, setOutput] = useState(model ? String(model.output_price_per_million) : '')
  const [isPending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await saveModelPrice({
        model: name,
        input_price_per_million: Number(input),
        output_price_per_million: Number(output),
      })
      if (result.ok) {
        toast.success(t('toast.saved'))
        onClose()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{model ? t('editTitle', { model: model.model }) : t('addTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="model-name">{t('columns.model')}</Label>
            <Input
              id="model-name"
              dir="ltr"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="gemini-3-flash-preview"
              disabled={!!model}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="model-input">{t('columns.input')}</Label>
              <Input id="model-input" type="number" min={0} step="0.000001" dir="ltr" value={input} onChange={(e) => setInput(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="model-output">{t('columns.output')}</Label>
              <Input id="model-output" type="number" min={0} step="0.000001" dir="ltr" value={output} onChange={(e) => setOutput(e.target.value)} required />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? tCommon('loading') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
