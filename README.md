# AI Report Summarizer

## Description

Upload a **PDF/DOCX** and get a clean, executive-ready **Markdown** summary (Executive Summary, Key Insights, Risks, Action Items).
Built with **Next.js**, **LangChain.js**, and the **OpenAI API**.

## Tech Stack

- **Next.js** (App Router: UI + API routes)
- **OpenAI API** (`gpt-4.1-mini`, JSON responses)
- **LangChain.js** (text splitting for long docs via `RecursiveCharacterTextSplitter`)
- **pdf-parse** (PDF text extraction)
- **mammoth** (DOCX text extraction)
- **zod** (runtime schema validation)

## Goal

Deliver a simple, AI-powered summarizer

## Env

Create .env.local -> refer .env.example

## Install deps

pnpm install

## Running Locally

pnpm dev (http://localhost:3000)

## Deployment

Deployed on **Vercel**

- Production: https://ai-report-summarizer.vercel.app
