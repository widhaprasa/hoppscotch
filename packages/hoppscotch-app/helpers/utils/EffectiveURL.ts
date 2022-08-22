import * as A from "fp-ts/Array"
import * as E from "fp-ts/Either"
import * as O from "fp-ts/Option"
import * as RA from "fp-ts/ReadonlyArray"
import * as S from "fp-ts/string"
import qs from "qs"
import { flow, pipe } from "fp-ts/function"
import { combineLatest, Observable } from "rxjs"
import { map } from "rxjs/operators"
import {
  FormDataKeyValue,
  HoppRESTReqBody,
  HoppRESTRequest,
  parseTemplateString,
  parseBodyEnvVariables,
  Environment,
  HoppRESTHeader,
  HoppRESTParam,
  parseRawKeyValueEntriesE,
  parseTemplateStringE,
} from "@hoppscotch/data"
import { arrayFlatMap, arraySort } from "../functional/array"
import { toFormData } from "../functional/formData"
import { tupleWithSameKeysToRecord } from "../functional/record"
import { getGlobalVariables } from "~/newstore/environments"

export interface EffectiveHoppRESTRequest extends HoppRESTRequest {
  /**
   * The effective final URL.
   *
   * This contains path, params and environment variables all applied to it
   */
  effectiveFinalURL: string
  effectiveFinalHeaders: { key: string; value: string }[]
  effectiveFinalParams: { key: string; value: string }[]
  effectiveFinalBody: FormData | string | null
  effectiveFinalVars: { key: string; value: string }[]
}

/**
 * Get headers that can be generated by authorization config of the request
 * @param req Request to check
 * @param envVars Currently active environment variables
 * @returns The list of headers
 */
const getComputedAuthHeaders = (
  req: HoppRESTRequest,
  envVars: Environment["variables"]
) => {
  // If Authorization header is also being user-defined, that takes priority
  if (req.headers.find((h) => h.key.toLowerCase() === "authorization"))
    return []

  if (!req.auth.authActive) return []

  const headers: HoppRESTHeader[] = []

  // TODO: Support a better b64 implementation than btoa ?
  if (req.auth.authType === "basic") {
    const username = parseTemplateString(req.auth.username, envVars)
    const password = parseTemplateString(req.auth.password, envVars)

    headers.push({
      active: true,
      key: "Authorization",
      value: `Basic ${btoa(`${username}:${password}`)}`,
    })
  } else if (
    req.auth.authType === "bearer" ||
    req.auth.authType === "oauth-2"
  ) {
    headers.push({
      active: true,
      key: "Authorization",
      value: `Bearer ${parseTemplateString(req.auth.token, envVars)}`,
    })
  } else if (req.auth.authType === "api-key") {
    const { key, value, addTo } = req.auth

    if (addTo === "Headers") {
      headers.push({
        active: true,
        key: parseTemplateString(key, envVars),
        value: parseTemplateString(value, envVars),
      })
    }
  }

  return headers
}

/**
 * Get headers that can be generated by body config of the request
 * @param req Request to check
 * @returns The list of headers
 */
export const getComputedBodyHeaders = (
  req: HoppRESTRequest
): HoppRESTHeader[] => {
  // If a content-type is already defined, that will override this
  if (
    req.headers.find(
      (req) => req.active && req.key.toLowerCase() === "content-type"
    )
  )
    return []

  // Body should have a non-null content-type
  if (req.body.contentType === null) return []

  return [
    {
      active: true,
      key: "content-type",
      value: req.body.contentType,
    },
  ]
}

export type ComputedHeader = {
  source: "auth" | "body"
  header: HoppRESTHeader
}

/**
 * Returns a list of headers that will be added during execution of the request
 * For e.g, Authorization headers maybe added if an Auth Mode is defined on REST
 * @param req The request to check
 * @param envVars The environment variables active
 * @returns The headers that are generated along with the source of that header
 */
export const getComputedHeaders = (
  req: HoppRESTRequest,
  envVars: Environment["variables"]
): ComputedHeader[] => [
  ...getComputedAuthHeaders(req, envVars).map((header) => ({
    source: "auth" as const,
    header,
  })),
  ...getComputedBodyHeaders(req).map((header) => ({
    source: "body" as const,
    header,
  })),
]

export type ComputedParam = {
  source: "auth"
  param: HoppRESTParam
}

/**
 * Returns a list of params that will be added during execution of the request
 * For e.g, Authorization params (like API-key) maybe added if an Auth Mode is defined on REST
 * @param req The request to check
 * @param envVars The environment variables active
 * @returns The params that are generated along with the source of that header
 */
export const getComputedParams = (
  req: HoppRESTRequest,
  envVars: Environment["variables"]
): ComputedParam[] => {
  // When this gets complex, its best to split this function off (like with getComputedHeaders)
  // API-key auth can be added to query params
  if (!req.auth.authActive) return []
  if (req.auth.authType !== "api-key") return []
  if (req.auth.addTo !== "Query params") return []

  return [
    {
      source: "auth",
      param: {
        active: true,
        key: parseTemplateString(req.auth.key, envVars),
        value: parseTemplateString(req.auth.value, envVars),
      },
    },
  ]
}

// Resolves environment variables in the body
export const resolvesEnvsInBody = (
  body: HoppRESTReqBody,
  env: Environment
): HoppRESTReqBody => {
  if (!body.contentType) return body

  if (body.contentType === "multipart/form-data") {
    return {
      contentType: "multipart/form-data",
      body: body.body.map(
        (entry) =>
          <FormDataKeyValue>{
            active: entry.active,
            isFile: entry.isFile,
            key: parseTemplateString(entry.key, env.variables),
            value: entry.isFile
              ? entry.value
              : parseTemplateString(entry.value, env.variables),
          }
      ),
    }
  } else {
    return {
      contentType: body.contentType,
      body: parseTemplateString(body.body, env.variables),
    }
  }
}

function getFinalBodyFromRequest(
  request: HoppRESTRequest,
  envVariables: Environment["variables"]
): FormData | string | null {
  if (request.body.contentType === null) {
    return null
  }

  if (request.body.contentType === "application/x-www-form-urlencoded") {
    const parsedBodyRecord = pipe(
      request.body.body,
      parseRawKeyValueEntriesE,
      E.map(
        flow(
          RA.toArray,
          /**
           * Filtering out empty keys and non-active pairs.
           */
          A.filter(({ active, key }) => active && !S.isEmpty(key)),

          /**
           * Mapping each key-value to template-string-parser with either on array,
           * which will be resolved in further steps.
           */
          A.map(({ key, value }) => [
            parseTemplateStringE(key, envVariables),
            parseTemplateStringE(value, envVariables),
          ]),

          /**
           * Filtering and mapping only right-eithers for each key-value as [string, string].
           */
          A.filterMap(([key, value]) =>
            E.isRight(key) && E.isRight(value)
              ? O.some([key.right, value.right] as [string, string])
              : O.none
          ),
          tupleWithSameKeysToRecord,
          (obj) => qs.stringify(obj, { indices: false })
        )
      )
    )
    return E.isRight(parsedBodyRecord) ? parsedBodyRecord.right : null
  }

  if (request.body.contentType === "multipart/form-data") {
    return pipe(
      request.body.body,
      A.filter((x) => x.key !== "" && x.active), // Remove empty keys

      // Sort files down
      arraySort((a, b) => {
        if (a.isFile) return 1
        if (b.isFile) return -1
        return 0
      }),

      // FormData allows only a single blob in an entry,
      // we split array blobs into separate entries (FormData will then join them together during exec)
      arrayFlatMap((x) =>
        x.isFile
          ? x.value.map((v) => ({
              key: parseTemplateString(x.key, envVariables),
              value: v as string | Blob,
            }))
          : [
              {
                key: parseTemplateString(x.key, envVariables),
                value: parseTemplateString(x.value, envVariables),
              },
            ]
      ),
      toFormData
    )
  } else return parseBodyEnvVariables(request.body.body, envVariables)
}

/**
 * Outputs an executable request format with environment variables applied
 *
 * @param request The request to source from
 * @param environment The environment to apply
 *
 * @returns An object with extra fields defining a complete request
 */
export function getEffectiveRESTRequest(
  request: HoppRESTRequest,
  environment: Environment
): EffectiveHoppRESTRequest {
  const envVariables = [...environment.variables, ...getGlobalVariables()]

  const effectiveFinalHeaders = pipe(
    getComputedHeaders(request, envVariables).map((h) => h.header),
    A.concat(request.headers),
    A.filter((x) => x.active && x.key !== ""),
    A.map((x) => ({
      active: true,
      key: parseTemplateString(x.key, envVariables),
      value: parseTemplateString(x.value, envVariables),
    }))
  )

  const effectiveFinalParams = pipe(
    getComputedParams(request, envVariables).map((p) => p.param),
    A.concat(request.params),
    A.filter((x) => x.active && x.key !== ""),
    A.map((x) => ({
      active: true,
      key: parseTemplateString(x.key, envVariables),
      value: parseTemplateString(x.value, envVariables),
    }))
  )
  const effectiveFinalVars = request.vars

  const effectiveFinalBody = getFinalBodyFromRequest(request, envVariables)

  return {
    ...request,
    effectiveFinalURL: parseTemplateString(
      request.endpoint,
      envVariables,
      request.vars
    ),
    effectiveFinalHeaders,
    effectiveFinalParams,
    effectiveFinalBody,
    effectiveFinalVars,
  }
}

/**
 * Creates an Observable Stream that emits HoppRESTRequests whenever
 * the input streams emit a value
 *
 * @param request$ The request stream containing request data
 * @param environment$ The environment stream containing environment data to apply
 *
 * @returns Observable Stream for the Effective Request Object
 */
export function getEffectiveRESTRequestStream(
  request$: Observable<HoppRESTRequest>,
  environment$: Observable<Environment>
): Observable<EffectiveHoppRESTRequest> {
  return combineLatest([request$, environment$]).pipe(
    map(([request, env]) => getEffectiveRESTRequest(request, env))
  )
}
