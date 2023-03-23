import { pipeline, Readable } from 'stream'
import express from 'express'
import createError from 'http-errors'
import axios, { AxiosError } from 'axios'
import { CID } from 'multiformats/cid'
import { ensureValidDid } from '@atproto/identifier'
import { VerifyCidTransform } from '@atproto/common'
import { NoResolveDidError } from '@atproto/did-resolver'
import AppContext from '../context'
import { httpLogger as log } from '../logger'

// Resolve and verify blob from its origin host

export const createRouter = (ctx: AppContext): express.Router => {
  const router = express.Router()

  router.get('/blob/:did/:cid', async function (req, res, next) {
    try {
      const { did, cid: cidStr } = req.params
      try {
        ensureValidDid(did)
      } catch (err) {
        return next(createError(400, 'Invalid did'))
      }
      let cid: CID
      try {
        cid = CID.parse(cidStr)
      } catch (err) {
        return next(createError(400, 'Invalid cid'))
      }

      const { pds } = await ctx.didResolver.resolveAtpData(did) // @TODO cache did info
      const getBlob = await axios.get(`${pds}/xrpc/com.atproto.sync.getBlob`, {
        params: { did, cid: cidStr },
        decompress: true,
        responseType: 'stream',
        timeout: 2000, // 2sec of inactivity on the connection
      })

      const imageStream: Readable = getBlob.data
      const verifyCid = new VerifyCidTransform(cid)

      // Send chunked response, destroying stream early (before
      // closing chunk) if the bytes don't match the expected cid.
      res.statusCode = 200
      res.setHeader(
        'content-type',
        getBlob.headers['content-type'] || 'application/octet-stream',
      )
      pipeline([imageStream, verifyCid, res], ignore)
    } catch (err) {
      if (err instanceof AxiosError) {
        if (err.code === AxiosError.ETIMEDOUT) {
          log.warn(
            { host: err.request?.host, path: err.request?.path },
            'blob resolution timeout',
          )
          return next(createError(504)) // Gateway timeout
        }
        if (!err.response || err.response.status >= 500) {
          log.warn(
            { host: err.request?.host, path: err.request?.path },
            'blob resolution failed upstream',
          )
          return next(createError(502))
        }
        return next(createError(404, 'Blob not found'))
      }
      if (err instanceof NoResolveDidError) {
        return next(createError(404, 'Blob not found'))
      }
      return next(err)
    }
  })

  return router
}

function ignore() {}
