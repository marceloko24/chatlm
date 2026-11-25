//go:build js && wasm

// ChatLM drives llama.cpp through yzma in a Web Worker.
package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"syscall/js"
	"time"
	"unicode/utf8"

	"github.com/hybridgroup/yzma/pkg/llamawasm"
)

const (
	modelPath          = "/models/model.gguf"
	defaultSystem      = "Sos un asistente útil. Respondé en español, de forma breve y clara."
	nCtx               = 512
	nBatch             = 128
	defaultMaxTokens   = 128
)

type turn struct {
	Role    string
	Content string
}

var (
	model   llamawasm.Model
	ctx     llamawasm.Context
	vocab   llamawasm.Vocab
	sampler llamawasm.Sampler

	history = []turn{{Role: "system", Content: defaultSystem}}

	stopping atomic.Bool
)

func main() {
	if err := llamawasm.Load(""); err != nil {
		post("error", "No se pudo iniciar el motor: "+err.Error())
		return
	}

	llamawasm.LogSet(llamawasm.LogSilent())
	llamawasm.Init()

	js.Global().Set("yzmaOpenModel", js.FuncOf(openModel))
	js.Global().Set("yzmaAsk", js.FuncOf(ask))
	js.Global().Set("yzmaStop", js.FuncOf(stop))
	js.Global().Set("yzmaReset", js.FuncOf(reset))
	js.Global().Set("yzmaSetSystem", js.FuncOf(setSystem))

	post("system", defaultSystem)
	post("ready", backendReport())

	<-make(chan struct{})
}

func openModel(this js.Value, args []js.Value) any {
	path := modelPath
	if len(args) > 0 && args[0].Truthy() {
		path = args[0].String()
	}
	go open(path)
	return nil
}

func open(path string) {
	post("status", "Cargando el modelo en el motor…")

	// Free a previous model if the user loads again.
	freeSampler()
	if ctx != 0 {
		_ = llamawasm.Free(ctx)
		ctx = 0
	}
	if model != 0 {
		_ = llamawasm.ModelFree(model)
		model = 0
	}

	params := llamawasm.ModelDefaultParams()
	var err error
	if model, err = llamawasm.ModelLoadFromFile(path, params); err != nil {
		post("error", "No se pudo cargar el modelo: "+err.Error())
		return
	}

	ctxParams := llamawasm.ContextDefaultParams()
	ctxParams.NCtx = nCtx
	ctxParams.NBatch = nBatch

	if ctx, err = llamawasm.InitFromModel(model, ctxParams); err != nil {
		post("error", "No se pudo crear el contexto: "+err.Error())
		return
	}

	vocab = llamawasm.ModelGetVocab(model)
	freeSampler()
	history = history[:1]

	template := llamawasm.ModelChatTemplate(model, "")
	if template == "" {
		post("status", "Este modelo no trae plantilla de chat; las respuestas pueden ser flojas.")
	}

	post("loaded", llamawasm.ModelDesc(model)+", "+backendReport())
}

func makeSampler() {
	freeSampler()
	sampler = llamawasm.SamplerChainInit(llamawasm.SamplerChainDefaultParams())
	llamawasm.SamplerChainAdd(sampler, llamawasm.SamplerInitPenalties(llamawasm.VocabNTokens(vocab), 64, 1.1, 0, 0))
	llamawasm.SamplerChainAdd(sampler, llamawasm.SamplerInitTopK(40))
	llamawasm.SamplerChainAdd(sampler, llamawasm.SamplerInitTopP(0.95, 1))
	llamawasm.SamplerChainAdd(sampler, llamawasm.SamplerInitTemp(0.7))
	llamawasm.SamplerChainAdd(sampler, llamawasm.SamplerInitDist(uint32(time.Now().UnixNano())))
}

func freeSampler() {
	if sampler != 0 {
		llamawasm.SamplerFree(sampler)
		sampler = 0
	}
}

func backendReport() string {
	return fmt.Sprintf("CPU, 1 hilo, contexto %d", nCtx)
}

func setSystem(this js.Value, args []js.Value) any {
	text := defaultSystem
	if len(args) > 0 && args[0].Truthy() {
		if trimmed := strings.TrimSpace(args[0].String()); trimmed != "" {
			text = trimmed
		}
	}
	history[0] = turn{Role: "system", Content: text}
	return nil
}

func reset(this js.Value, args []js.Value) any {
	stopping.Store(true)
	history = history[:1]
	post("reset", "")
	return nil
}

func stop(this js.Value, args []js.Value) any {
	stopping.Store(true)
	return nil
}

func ask(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		post("error", "Falta la pregunta.")
		return nil
	}
	question := args[0].String()

	maxTokens := int32(defaultMaxTokens)
	if len(args) > 1 && args[1].Truthy() {
		maxTokens = int32(args[1].Int())
	}

	go func() {
		stopping.Store(false)

		if model == 0 || ctx == 0 {
			post("error", "Primero hay que cargar un modelo.")
			return
		}

		history = append(history, turn{Role: "user", Content: question})

		tokens := prompt(maxTokens)
		if len(tokens) == 0 {
			post("error", "El prompt no produjo tokens.")
			return
		}

		if err := llamawasm.MemoryClear(ctx, true); err != nil {
			post("error", err.Error())
			return
		}
		makeSampler()

		var (
			reply strings.Builder
			count int32
			hold  string
		)
		batch := llamawasm.BatchGetOne(tokens)
		buf := make([]byte, 64)
		start := time.Now()

		for count < maxTokens && !stopping.Load() {
			if _, err := llamawasm.Decode(ctx, batch); err != nil {
				post("error", "Error al generar: "+err.Error())
				return
			}

			token := llamawasm.SamplerSample(sampler, ctx, -1)
			if llamawasm.VocabIsEOG(vocab, token) {
				break
			}

			if n := llamawasm.TokenToPiece(vocab, token, buf, 0, true); n > 0 {
				hold += string(buf[:n])
				// Hold back a few bytes so a multibyte character is not split.
				if keep := 3; len(hold) > keep {
					cut := len(hold) - keep
					for cut > 0 && !utf8.RuneStart(hold[cut]) {
						cut--
					}
					if cut > 0 {
						piece := hold[:cut]
						hold = hold[cut:]
						reply.WriteString(piece)
						post("token", piece)
					}
				}
			}

			count++
			batch = llamawasm.BatchGetOne([]llamawasm.Token{token})
			yield()
		}

		if hold != "" {
			reply.WriteString(hold)
			post("token", hold)
		}

		history = append(history, turn{Role: "assistant", Content: reply.String()})

		note := ""
		if stopping.Load() {
			note = ", detenido"
		}
		if count == 0 && !stopping.Load() {
			post("error", "El modelo no generó ninguna respuesta.")
			return
		}

		if elapsed := time.Since(start).Seconds(); elapsed > 0 && count > 0 {
			post("done", fmt.Sprintf("%d tokens, %.1f tokens/s%s", count, float64(count)/elapsed, note))
			return
		}
		post("done", fmt.Sprintf("%d tokens%s", count, note))
	}()

	return nil
}

func prompt(maxTokens int32) []llamawasm.Token {
	for {
		var text strings.Builder
		for i, message := range history {
			formatted, err := llamawasm.ChatApplyTemplate(model, message.Role, message.Content, i == len(history)-1)
			if err != nil {
				return llamawasm.Tokenize(vocab, history[len(history)-1].Content, true, false)
			}
			text.WriteString(formatted)
		}

		tokens := llamawasm.Tokenize(vocab, text.String(), true, true)

		if int32(len(tokens)) <= nCtx-maxTokens || len(history) <= 2 {
			return tokens
		}

		drop := 2
		if len(history) < 1+drop {
			drop = len(history) - 1
		}
		history = append(history[:1], history[1+drop:]...)
	}
}

func post(kind, text string) {
	message := map[string]any{"kind": kind, "text": text}
	if fn := js.Global().Get("postMessage"); fn.Type() == js.TypeFunction {
		fn.Invoke(message)
		return
	}
	fmt.Printf("%s: %s\n", kind, text)
}

// yield lets the worker handle Parar and paint the next token.
func yield() {
	done := make(chan struct{})
	var fn js.Func
	fn = js.FuncOf(func(this js.Value, args []js.Value) any {
		fn.Release()
		close(done)
		return nil
	})
	js.Global().Get("setTimeout").Invoke(fn, 0)
	<-done
}
